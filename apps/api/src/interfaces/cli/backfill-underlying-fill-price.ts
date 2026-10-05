import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

/**
 * One-off backfill for `paper_trades.underlying_fill_price` (migration 120).
 *
 * ## Why this is a backfill at all, unlike `underlying_exit_price`
 *
 * Migrations 089/090/091 deliberately never backfill an observed-price column, specifically so
 * that "non-null" can mean "this was actually observed in real time" without qualification. This
 * script breaks that pattern on purpose, for the same reason migration 120's own comment gives:
 * the field exists to correct a *measured* wrong diagnosis on already-closed historical trades,
 * and refusing to backfill would leave every trade before this fix permanently unreadable for the
 * one question it was added to answer. The provenance column (`underlying_fill_price_source`)
 * keeps the distinction migrations 089-091 were protecting: a reconstructed value is tagged
 * `BACKFILLED_FROM_QUOTE_OBSERVED_AT` or `BACKFILLED_NEAREST_TICK`, never conflated with a value
 * observed live at the fill.
 *
 * ## Matching logic: the real pricing tick first, the nearest-in-time tick only as a fallback
 *
 * The first version of this script found the single `option_premium_ticks` row NEAREST IN TIME
 * to `opened_at`. That is a real defect, not just an approximation: `opened_at` is when the trade
 * record was written, which can trail the quote that actually priced the fill by however long the
 * entry pipeline took after observing it. "Closest in clock time to `opened_at`" and "the tick
 * that priced the fill" are the same instant only when that lag happens to be small -- and
 * confirmed live on trade `535e5951-56e3-4323-b8af-f47e5f6812c5` (AutoBot-Scalp1m, BANKNIFTY
 * 54900 CE), they were not: the real pricing tick (`quoteObservedAt` = 2026-10-01T04:04:01.257Z)
 * read `underlying_value = 54862.45`, but the nearest-to-`opened_at` heuristic picked a tick a
 * full 60 seconds later (04:05:01.781Z) reading `underlying_value = 54793.85` -- a different tick
 * describing a different market, chosen only because `opened_at` (04:05:01.526Z) happened to sit
 * closer to it on the clock.
 *
 * `prepare-option-entry.ts` already records the instant that actually priced the fill, on every
 * trade, at `fee_breakdown.entryChecks.quoteObservedAt` (`observedFill.observedAt.toISOString()`
 * -- see that file). So for each candidate trade this script now:
 *
 *   1. Reads `quoteObservedAt` out of `fee_breakdown` and looks for the `option_premium_ticks` row
 *      for the same contract (`underlying_symbol`, `expiry_date`, `strike_price`, `option_type`)
 *      whose `observed_at` is within `QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS` of it. A tolerance
 *      rather than exact equality because the value survives a JSON round-trip (ISO-string
 *      serialization, float formatting) that can shift it by sub-second amounts without it being
 *      a different tick. When found, this is tagged `BACKFILLED_FROM_QUOTE_OBSERVED_AT` -- the
 *      exact tick that priced the fill, reconstructed after the fact.
 *   2. Only when `quoteObservedAt` is missing (older trades, before that field existed) or no tick
 *      matches it within tolerance, falls back to the original nearest-to-`opened_at` search,
 *      tagged `BACKFILLED_NEAREST_TICK` -- the same weaker heuristic as before, kept only as a
 *      fallback rather than removed, since `opened_at` is the best available anchor when the real
 *      pricing instant cannot be recovered.
 *
 * "Nearest" in both searches is absolute distance in either direction: the trade's own recorded
 * instant is not a lower bound to search backward from (that asymmetry is what the live fill
 * path's own freshness gate needs; this script is reconstructing a single instant after the fact,
 * so the closest sample on either side is the best available estimate).
 *
 * ## Staleness tolerance
 *
 * The nearest-tick fallback is bounded to `MAXIMUM_BACKFILL_TICK_AGE_MS` (2 minutes, mirroring
 * `MAXIMUM_EXECUTABLE_QUOTE_AGE_MS` in `prepare-option-entry.ts` -- the same window the live
 * system itself requires between an observed ask and the fill it prices). A trade with no tick
 * inside this window, by either path, is left null rather than filled from a tick far enough away
 * to be a different market.
 *
 * ## Re-running against trades this script already touched
 *
 * Unlike the first version, the candidate query also re-examines every trade already tagged
 * `BACKFILLED_NEAREST_TICK` -- the whole population the flawed heuristic could have mispriced --
 * not only trades with a still-null `underlying_fill_price`. A trade already tagged
 * `OPTION_PREMIUM_TICK_ASK` or `OPTION_CHAIN_QUOTE` (observed live, at insert time) is never
 * touched: this script corrects its own prior reconstruction, it does not second-guess a live
 * observation.
 */

/** See `apps/api/src/modules/paper-trading/application/prepare-option-entry.ts`. */
export const MAXIMUM_BACKFILL_TICK_AGE_MS = 2 * 60 * 1000;

/**
 * How close an `option_premium_ticks.observed_at` must be to `quoteObservedAt` to count as the
 * same tick, not a search tolerance in the nearest-tick sense. `quoteObservedAt` is written from
 * the exact row this script is trying to recover, so the only drift expected is JSON/ISO-string
 * round-tripping -- a few hundred milliseconds covers that comfortably without risking a match
 * against the next tick in a ~5s-cadence series.
 */
export const QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS = 500;

export type FillPriceSource = "BACKFILLED_FROM_QUOTE_OBSERVED_AT" | "BACKFILLED_NEAREST_TICK";

interface CandidateRow {
  trade_id: string;
  underlying_fill_price: string | null;
  underlying_fill_price_source: string | null;
  fee_breakdown: Record<string, unknown> | null;
  underlying_symbol: string;
  option_expiry: Date;
  option_strike: string;
  option_type: string;
  opened_at: Date;
}

interface TickMatchRow {
  underlying_value: string | null;
}

export interface TickQueryClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface OptionContractIdentity {
  underlyingSymbol: string;
  expiryDate: Date;
  strikePrice: number | string;
  optionType: string;
}

/**
 * `fee_breakdown.entryChecks.quoteObservedAt`, the exact instant `prepare-option-entry.ts`
 * recorded as having priced the fill. Returns null for anything that does not parse to a real
 * date -- missing field, malformed JSON shape, or a pre-this-field historical trade -- so the
 * caller falls back to the nearest-tick heuristic rather than matching against garbage.
 */
export function extractQuoteObservedAt(feeBreakdown: Record<string, unknown> | null): Date | null {
  if (feeBreakdown === null || typeof feeBreakdown !== "object") return null;
  const entryChecks = (feeBreakdown as Record<string, unknown>).entryChecks;
  if (entryChecks === null || typeof entryChecks !== "object") return null;
  const raw = (entryChecks as Record<string, unknown>).quoteObservedAt;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The matching logic itself, isolated from the candidate scan and the UPDATE so it can be
 * exercised directly: try the exact tick `quoteObservedAt` identifies, within
 * `QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS`; only when that is unavailable (no `quoteObservedAt`, or
 * nothing matched it), fall back to the nearest tick to `openedAt` within
 * `MAXIMUM_BACKFILL_TICK_AGE_MS`. Returns null when neither path finds a usable tick.
 */
export async function resolveBackfillFillPrice(
  client: TickQueryClient,
  contract: OptionContractIdentity,
  openedAt: Date,
  quoteObservedAt: Date | null,
): Promise<{ value: number; source: FillPriceSource } | null> {
  if (quoteObservedAt !== null) {
    const exact = await client.query<TickMatchRow>(`
      SELECT tick.underlying_value
      FROM option_premium_ticks tick
      WHERE UPPER(tick.underlying_symbol) = UPPER($1)
        AND tick.expiry_date = $2::date
        AND tick.strike_price = $3
        AND tick.option_type = $4
        AND tick.underlying_value IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (tick.observed_at - $5::timestamptz))) * 1000 <= $6
      ORDER BY ABS(EXTRACT(EPOCH FROM (tick.observed_at - $5::timestamptz)))
      LIMIT 1
    `, [
      contract.underlyingSymbol, contract.expiryDate, contract.strikePrice, contract.optionType,
      quoteObservedAt.toISOString(), QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS,
    ]);
    const matched = exact.rows[0]?.underlying_value;
    const parsed = matched === undefined || matched === null ? Number.NaN : Number(matched);
    if (Number.isFinite(parsed)) {
      return { value: parsed, source: "BACKFILLED_FROM_QUOTE_OBSERVED_AT" };
    }
  }

  const nearest = await client.query<TickMatchRow & { age_ms: string | null }>(`
    SELECT tick.underlying_value,
           ABS(EXTRACT(EPOCH FROM (tick.observed_at - $5::timestamptz))) * 1000 AS age_ms
    FROM option_premium_ticks tick
    WHERE UPPER(tick.underlying_symbol) = UPPER($1)
      AND tick.expiry_date = $2::date
      AND tick.strike_price = $3
      AND tick.option_type = $4
      AND tick.underlying_value IS NOT NULL
    ORDER BY ABS(EXTRACT(EPOCH FROM (tick.observed_at - $5::timestamptz)))
    LIMIT 1
  `, [contract.underlyingSymbol, contract.expiryDate, contract.strikePrice, contract.optionType, openedAt]);
  const nearestRow = nearest.rows[0];
  const ageMs = nearestRow?.age_ms === undefined || nearestRow?.age_ms === null
    ? null : Number(nearestRow.age_ms);
  const parsed = nearestRow?.underlying_value === undefined || nearestRow?.underlying_value === null
    ? Number.NaN : Number(nearestRow.underlying_value);
  if (ageMs !== null && ageMs <= MAXIMUM_BACKFILL_TICK_AGE_MS && Number.isFinite(parsed)) {
    return { value: parsed, source: "BACKFILLED_NEAREST_TICK" };
  }
  return null;
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const client = await database.connect();
  try {
    const candidates = await client.query<CandidateRow>(`
      SELECT
        trade.id AS trade_id,
        trade.underlying_fill_price,
        trade.underlying_fill_price_source,
        trade.fee_breakdown,
        trade.underlying_symbol,
        trade.option_expiry,
        trade.option_strike,
        trade.option_type,
        trade.opened_at
      FROM paper_trades trade
      WHERE trade.status = 'CLOSED'
        AND (
          trade.underlying_fill_price IS NULL
          OR trade.underlying_fill_price_source = 'BACKFILLED_NEAREST_TICK'
        )
        AND trade.option_strike IS NOT NULL
        AND trade.option_expiry IS NOT NULL
        AND trade.option_type IS NOT NULL
        AND trade.underlying_symbol IS NOT NULL
      ORDER BY trade.opened_at ASC
    `);

    let backfilledFromQuoteObservedAt = 0;
    let backfilledFromNearestTick = 0;
    let correctedFromPriorBackfill = 0;
    let noNearbyTick = 0;
    const skippedIds: string[] = [];
    const correctedIds: string[] = [];

    for (const row of candidates.rows) {
      const quoteObservedAt = extractQuoteObservedAt(row.fee_breakdown);
      const resolved = await resolveBackfillFillPrice(client, {
        underlyingSymbol: row.underlying_symbol,
        expiryDate: row.option_expiry,
        strikePrice: row.option_strike,
        optionType: row.option_type,
      }, row.opened_at, quoteObservedAt);

      if (resolved === null) {
        noNearbyTick += 1;
        skippedIds.push(row.trade_id);
        continue;
      }
      const { value: newValue, source: newSource } = resolved;

      const previousValue = row.underlying_fill_price === null ? null : Number(row.underlying_fill_price);
      const previouslyBackfilledNearest = row.underlying_fill_price_source === "BACKFILLED_NEAREST_TICK";
      const valueChanged = previousValue === null || !Number.isFinite(previousValue)
        || Math.abs(previousValue - newValue) > 1e-6;

      if (previouslyBackfilledNearest && valueChanged) {
        correctedFromPriorBackfill += 1;
        correctedIds.push(row.trade_id);
      }

      // Skip a genuine no-op (same value, same source already on the row) rather than rewriting
      // identical data -- only meaningful for the re-examined BACKFILLED_NEAREST_TICK population,
      // where the fallback path can legitimately reproduce what was already there.
      if (!valueChanged && row.underlying_fill_price_source === newSource) {
        if (newSource === "BACKFILLED_FROM_QUOTE_OBSERVED_AT") backfilledFromQuoteObservedAt += 1;
        else backfilledFromNearestTick += 1;
        continue;
      }

      await client.query(`
        UPDATE paper_trades
        SET underlying_fill_price = $2,
            underlying_fill_price_source = $3
        WHERE id = $1
          AND (underlying_fill_price IS NULL OR underlying_fill_price_source = 'BACKFILLED_NEAREST_TICK')
      `, [row.trade_id, newValue, newSource]);

      if (newSource === "BACKFILLED_FROM_QUOTE_OBSERVED_AT") backfilledFromQuoteObservedAt += 1;
      else backfilledFromNearestTick += 1;
    }

    console.log(JSON.stringify({
      level: "info",
      message: "underlying_fill_price backfill complete",
      candidates: candidates.rows.length,
      backfilledFromQuoteObservedAt,
      backfilledFromNearestTick,
      correctedFromPriorBackfill,
      noNearbyTick,
      staleToleranceMs: MAXIMUM_BACKFILL_TICK_AGE_MS,
      quoteObservedAtMatchToleranceMs: QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS,
      correctedTradeIds: correctedIds.slice(0, 20),
      skippedTradeIds: skippedIds.slice(0, 20),
    }));
  } finally {
    client.release();
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
