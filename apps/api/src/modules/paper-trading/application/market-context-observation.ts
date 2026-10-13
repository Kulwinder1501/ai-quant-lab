/**
 * Log-only Market Context Map stamp for AutoBot-Sniper opens.
 *
 * Normative: docs/2026-10-13-market-context-observation-protocol.md
 *
 * Must never block, resize, or delay an entry. Lookup failures return null (trade opens
 * unstamped) — unknown, not "no context".
 */

import {
  buildFixedRowVolumeProfile,
  type ProfileBar,
} from "../../market-data/domain/fixed-row-volume-profile.js";
import {
  MARKET_CONTEXT_ALGORITHM_VERSION,
  buildMarketContextMap,
  marketContextStampBody,
  type ContextBar,
  type TradeDirection,
} from "../../market-context/domain/market-context-map.js";
import { trendSlicesFromHigherTimeframeContexts } from "../../strategy-engine/domain/digest-higher-timeframes.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { HistoricalTimeframe } from "../../market-data/domain/historical-data-provider.js";

export const MARKET_CONTEXT_OBSERVATION_CODE = "MKT_CTX";

const MINIMUM_PRIOR_MINUTES = 200;
const ATR_PERIOD = 14;
const INDIA_OFFSET_MS = 5.5 * 3_600_000;
const SESSION_LOOKBACK_DAYS = 10;

export interface MarketContextObservationDatabase {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MarketContextObservationInput {
  database: MarketContextObservationDatabase;
  underlyingSymbol: string;
  tradeIdeaId: string;
  direction: TradeDirection;
  now: Date;
  /**
   * Optional already-attached HTF contexts (when the caller has them). Observation does not
   * require them; trend fields become UNKNOWN / null without them.
   */
  higherTimeframeContexts?: Partial<Record<HistoricalTimeframe, StrategyMarketContext>>;
}

function indiaDate(instant: Date): string {
  return new Date(instant.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function stamp(body: Record<string, unknown>): string {
  return ` Observed (log-only, no effect on entry): ${MARKET_CONTEXT_OBSERVATION_CODE} ${JSON.stringify({
    v: body.v ?? MARKET_CONTEXT_ALGORITHM_VERSION,
    ...body,
  })}`;
}

function toContextBars(rows: ReadonlyArray<Record<string, unknown>>): ContextBar[] {
  return rows.map((row) => ({
    openTime: new Date(row.open_time as string | Date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  }));
}

function atr14(bars: readonly ContextBar[]): number {
  if (bars.length < 2) return 0;
  const start = Math.max(1, bars.length - ATR_PERIOD);
  let sum = 0;
  let n = 0;
  for (let i = start; i < bars.length; i += 1) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Returns the note fragment to append, or null when the lookup itself failed.
 */
export async function observeMarketContext(input: MarketContextObservationInput): Promise<string | null> {
  try {
    const today = indiaDate(input.now);
    const startOfToday = new Date(`${today}T00:00:00+05:30`);
    const since = new Date(startOfToday.getTime() - SESSION_LOOKBACK_DAYS * 86_400_000);
    const completedBefore = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);

    const ideaResult = await input.database.query(
      "SELECT entry_price::float8 AS entry_price FROM trade_ideas WHERE id = $1",
      [input.tradeIdeaId],
    );
    const entry = Number(ideaResult.rows[0]?.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) {
      return stamp({ dq: "FAIL", reason: "NO_ENTRY_PRICE" });
    }

    const indexResult = await input.database.query(
      `SELECT id::text AS id FROM instruments
        WHERE symbol = $1 AND instrument_type = 'INDEX'
        LIMIT 1`,
      [input.underlyingSymbol],
    );
    const indexId = indexResult.rows[0]?.id;
    if (!indexId) {
      return stamp({ dq: "FEATURE_UNAVAILABLE", reason: "NO_INDEX" });
    }

    const priorSessionResult = await input.database.query(
      `SELECT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS session_date
         FROM candles c
        WHERE c.instrument_id = $1::uuid
          AND c.timeframe = '1m'
          AND c.is_complete
          AND c.open_time >= $2
          AND c.open_time < $3
        GROUP BY 1
       HAVING COUNT(*) >= $4
        ORDER BY 1 DESC
        LIMIT 1`,
      [indexId, since, startOfToday, MINIMUM_PRIOR_MINUTES],
    );
    const priorDate = priorSessionResult.rows[0]?.session_date
      ? String(priorSessionResult.rows[0].session_date)
      : null;

    const loadSession = async (date: string, before: Date | null) => {
      const result = await input.database.query(
        `SELECT open_time, open::float8 AS open, high::float8 AS high,
                low::float8 AS low, close::float8 AS close, volume::float8 AS volume
           FROM candles
          WHERE instrument_id = $1::uuid
            AND timeframe = '1m'
            AND is_complete
            AND (open_time AT TIME ZONE 'Asia/Kolkata')::date = $2::date
            AND ($3::timestamptz IS NULL OR open_time < $3::timestamptz)
          ORDER BY open_time`,
        [indexId, date, before],
      );
      return toContextBars(result.rows);
    };

    const sessionBars = await loadSession(today, completedBefore);
    const priorSessionBars = priorDate ? await loadSession(priorDate, null) : [];

    // Optional FRVP prior VA: densest FUTURE that day, volume on index range (same as FRVP_OBS).
    let priorValueArea: { vah: number; val: number; poc: number } | null = null;
    if (priorDate) {
      const fut = await input.database.query(
        `SELECT f.id::text AS instrument_id
           FROM instruments f
           JOIN candles c ON c.instrument_id = f.id AND c.timeframe = '1m' AND c.is_complete
          WHERE f.instrument_type = 'FUTURE'
            AND f.underlying_symbol = $1
            AND f.expiry_date >= $2::date
            AND (c.open_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
          GROUP BY f.id
          ORDER BY SUM(c.volume) DESC NULLS LAST
          LIMIT 1`,
        [input.underlyingSymbol, today, priorDate],
      );
      const futId = fut.rows[0]?.instrument_id;
      if (futId) {
        const paired = await input.database.query(
          `SELECT ic.high::float8 AS high, ic.low::float8 AS low, ic.close::float8 AS close,
                  fc.volume::float8 AS volume
             FROM candles fc
             JOIN candles ic
               ON ic.instrument_id = $1::uuid AND ic.timeframe = '1m' AND ic.is_complete
              AND ic.open_time = fc.open_time
            WHERE fc.instrument_id = $2::uuid
              AND fc.timeframe = '1m'
              AND fc.is_complete
              AND fc.volume > 0
              AND (fc.open_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
            ORDER BY fc.open_time`,
          [indexId, futId, priorDate],
        );
        const profileBars: ProfileBar[] = paired.rows.map((row) => ({
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        }));
        const profile = buildFixedRowVolumeProfile(profileBars);
        if (profile) {
          priorValueArea = { vah: profile.vah, val: profile.val, poc: profile.poc };
        }
      }
    }

    // Swing S/R from recent price_action_events on index 1m candles (event_type + known_at).
    let swingLevels: Array<{ kind: "SUPPORT" | "RESISTANCE"; level: number }> = [];
    try {
      const swings = await input.database.query(
        `SELECT pae.event_type, pae.level::float8 AS level
           FROM price_action_events pae
           JOIN candles c ON c.id = pae.candle_id
          WHERE c.instrument_id = $1::uuid
            AND c.timeframe = '1m'
            AND pae.event_type IN ('SUPPORT', 'RESISTANCE')
            AND pae.level IS NOT NULL
            AND pae.known_at >= $2
            AND pae.known_at <= $3
          ORDER BY pae.known_at DESC
          LIMIT 40`,
        [indexId, since, completedBefore],
      );
      swingLevels = swings.rows
        .filter((row) => row.event_type === "SUPPORT" || row.event_type === "RESISTANCE")
        .map((row) => ({
          kind: row.event_type as "SUPPORT" | "RESISTANCE",
          level: Number(row.level),
        }));
    } catch {
      swingLevels = [];
    }

    const slices = trendSlicesFromHigherTimeframeContexts(input.higherTimeframeContexts);
    const atr = atr14(sessionBars);
    const map = buildMarketContextMap({
      sessionBars,
      priorSessionBars,
      atr,
      price: entry,
      direction: input.direction,
      swingLevels,
      priorValueArea,
      tf5: slices.tf5,
      tf15: slices.tf15,
      sessionDateIst: today,
    });

    return stamp(marketContextStampBody(map));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Market-context observation failed; the trade opens unstamped.",
      underlyingSymbol: input.underlyingSymbol,
      tradeIdeaId: input.tradeIdeaId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
