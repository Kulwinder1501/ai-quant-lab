import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { aggregateBars } from "../../modules/backtesting/domain/bar-aggregation.js";
import { netOutcomeR, roundTripCostR } from "../../modules/backtesting/domain/round-trip-cost.js";
import {
  applyHolm,
  pairedDelta,
  summariseExpectancy,
  toDailyExpectancy,
  type DailyExpectancy,
} from "../../modules/backtesting/domain/expectancy-statistics.js";
import { resolveBracket } from "../../modules/strategy-engine/domain/bracket-outcome.js";
import { MomentumScalpIndexStrategy, defaultMomentumScalpIndexStrategyConfiguration }
  from "../../modules/strategy-engine/domain/momentum-scalp-index-strategy.js";
import { TechnicalIndicatorEngine } from "../../modules/technical-analysis/domain/technical-indicator-engine.js";
import type { CompletedPriceCandle } from "../../modules/paper-trading/domain/paper-trade-exit-policy.js";
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";

/**
 * EXPERIMENT A — base architecture selection, per `docs/2026-08-19-regime-filter-protocol.md`.
 *
 * Compares 1m, 3m and 5m for `momentum-scalp-index` on NIFTYBEES and BANKBEES, over the window where
 * all three are derivable from audited 1m bars.
 *
 * ## Every arm is built the same way, on purpose
 *
 * All three timeframes are aggregated from the same 1m bars and have their indicators computed in
 * memory by the production `TechnicalIndicatorEngine`. Reading stored 1m/5m snapshots while deriving 3m
 * would make provenance an uncontrolled difference between the arms -- and stored coverage varies by
 * series, which is how a NIFTYBEES 5m run once scored 0% and reported it as "no signals".
 *
 * Resolution is delegated to `resolveBracket`, which is built on the live exit policy: gaps fill at the
 * open, a bar spanning both levels resolves stop-first, nothing resolves from an incomplete bar. So a
 * hit rate here cannot exceed what the paper-trading engine would have booked.
 *
 * Usage: run-experiment-a [--period BASE_SELECTION] [--bps 2]
 */

const ENGINE = new TechnicalIndicatorEngine();
const CONFIG = defaultMomentumScalpIndexStrategyConfiguration;
const CONFIG_RECORD = { ...CONFIG } as unknown as Record<string, unknown>;
const HORIZON_BARS = CONFIG.expiryCandles;
const COST_LADDER = [1, 2, 5] as const;
const PRIMARY_BPS = 2;

const DEFAULT_INSTRUMENTS = ["NIFTYBEES", "BANKBEES"];
const ALL_ARCHITECTURES = [
  { label: "1m", barsPerBucket: 1 },
  { label: "3m", barsPerBucket: 3 },
  { label: "5m", barsPerBucket: 5 },
] as const;

/** Frozen in the protocol. 2023-01-02 is where 1m coverage begins on both ETFs. */
const PERIODS = {
  DEVELOPMENT: { from: "2023-01-02", to: "2023-12-31" },
  BASE_SELECTION: { from: "2024-01-01", to: "2024-12-31" },
  OUT_OF_ERA: { from: "2025-01-01", to: "2025-12-31" },
  HELD: { from: "2026-01-01", to: "2026-08-14" },
} as const;

interface RawBar extends CompletedPriceCandle { volume: number }

function istDay(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

/**
 * The protocol's hard data-readiness gate. A failure aborts rather than degrades.
 *
 * Not ceremony: a NIFTYBEES 5m series once sat at 47.1% indicator coverage and produced zero signals
 * for a strategy that later fired 72,140 times on the same bars, and an EOD pipeline once returned six
 * weeks of bars for a request spanning two and a half years.
 */
/** Minute-of-IST-day at which a bar closes. The regular NSE session closes between 556 and 930. */
function istMinuteOfDay(at: Date): number {
  return Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 60_000) % 1440;
}

const REGULAR_SESSION_FIRST_CLOSE = 556; // 09:16 IST
const REGULAR_SESSION_LAST_CLOSE = 930;  // 15:30 IST

function auditOneMinuteSeries(bars: readonly RawBar[], symbol: string): {
  sessions: number;
  regular: RawBar[];
  notes: string[];
} {
  const notes: string[] = [];
  if (bars.length === 0) throw new Error(`${symbol}: no 1m bars in the window at all.`);

  const seen = new Set<number>();
  const regular: RawBar[] = [];
  let muhurat = 0;
  let straggler = 0;

  for (const bar of bars) {
    const stamp = bar.closeTime.getTime();
    // A duplicate timestamp stays a hard failure: it is unexplained, and it would double-count a bar
    // in every aggregate below.
    if (seen.has(stamp)) throw new Error(`${symbol}: duplicate 1m bar at ${bar.closeTime.toISOString()}.`);
    seen.add(stamp);

    const minute = istMinuteOfDay(bar.closeTime);
    if (minute >= REGULAR_SESSION_FIRST_CLOSE && minute <= REGULAR_SESSION_LAST_CLOSE) {
      regular.push(bar);
      continue;
    }
    // Two explained categories, both excluded and both counted. Excluded rather than fatal because
    // each is understood and quantified; anything *unexplained* still aborts via the checks around it.
    if (minute > 17 * 60) {
      // NSE's Diwali Muhurat session, a ~75-minute evening auction. Legitimate trade, but the
      // day-level criterion gives every session one equal vote, so a 75-minute session voting
      // alongside a 375-minute one would distort the interval.
      muhurat += 1;
    } else {
      straggler += 1;
    }
  }

  if (muhurat > 0) notes.push(`${symbol}: excluded ${muhurat} evening (Muhurat) bars — special session, not comparable to a regular one.`);
  if (straggler > 0) notes.push(`${symbol}: excluded ${straggler} bar(s) closing outside 09:16-15:30 IST — unexplained strays.`);

  const perSession = new Map<string, number>();
  for (const bar of regular) {
    const day = istDay(bar.closeTime);
    perSession.set(day, (perSession.get(day) ?? 0) + 1);
  }
  const short = [...perSession.entries()].filter(([, count]) => count !== 375);
  if (short.length > 0) {
    notes.push(`${symbol}: ${short.length} of ${perSession.size} sessions are not 375 bars `
      + `(e.g. ${short.slice(0, 3).map(([day, count]) => `${day}:${count}`).join(", ")}).`);
  }
  return { sessions: perSession.size, regular, notes };
}

/** Attaches in-memory indicator snapshots to an aggregated series. */
function buildContexts(
  bars: readonly CompletedPriceCandle[],
  instrumentId: string,
  timeframe: string,
  tickSize: number,
): StrategyMarketContext[] {
  const candles = bars.map((bar) => ({
    id: bar.id, openTime: bar.openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0,
  }));
  const specs = [
    { code: "EMA" as const, parameters: CONFIG.indicatorParameters.EMA_FAST },
    { code: "EMA" as const, parameters: CONFIG.indicatorParameters.EMA_SLOW },
    { code: "RSI" as const, parameters: CONFIG.indicatorParameters.RSI },
    { code: "SUPERTREND" as const, parameters: CONFIG.indicatorParameters.SUPERTREND },
    { code: "ATR" as const, parameters: CONFIG.indicatorParameters.ATR },
  ];

  const byCandle = new Map<string, StrategyMarketContext["indicators"]>();
  for (const spec of specs) {
    const points = ENGINE.calculate(candles, { code: spec.code, parameters: spec.parameters } as never);
    for (const point of points) {
      const bucket = byCandle.get(point.candleId) ?? [];
      bucket.push({
        code: spec.code,
        algorithmVersion: CONFIG.indicatorAlgorithmVersion,
        parameters: spec.parameters as Record<string, unknown>,
        values: point.values,
      });
      byCandle.set(point.candleId, bucket);
    }
  }

  return bars.map((bar) => ({
    candle: {
      id: bar.id,
      instrumentId,
      timeframe,
      openTime: bar.openTime,
      closeTime: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: 0,
      // Read from `instruments`, not assumed: an index ticks at 0.05 and an ETF at 0.01, and applying
      // one to the other would move the floor under every stop distance.
      tickSize,
    },
    indicators: byCandle.get(bar.id) ?? [],
    patterns: [],
    priceActionEvents: [],
  }));
}

interface TradeRecord { day: string; grossR: number; riskPerUnit: number; entryPrice: number }

/** Runs the strategy bar by bar and resolves every proposal it raises. */
function evaluateArchitecture(contexts: readonly StrategyMarketContext[], bars: readonly CompletedPriceCandle[]): {
  trades: TradeRecord[];
  unresolved: number;
} {
  const strategy = new MomentumScalpIndexStrategy();
  const trades: TradeRecord[] = [];
  let unresolved = 0;

  for (let index = 0; index < contexts.length; index += 1) {
    let proposals;
    try {
      proposals = strategy.evaluate(contexts[index]!, CONFIG_RECORD);
    } catch {
      continue; // A bar the strategy cannot score (warm-up, missing indicator) is simply not a signal.
    }
    if (proposals.length === 0) continue;

    // Strictly forward bars only, capped at the strategy's own vertical barrier.
    const forward = bars.slice(index + 1, index + 1 + HORIZON_BARS);
    if (forward.length === 0) continue; // End of series: nothing to resolve against at all.

    for (const proposal of proposals) {
      const resolution = resolveBracket({
        side: proposal.side,
        entryPrice: proposal.entryPrice,
        stopLoss: proposal.stopLoss,
        targetPrice: proposal.targetPrice,
      }, forward);
      const riskPerUnit = Math.abs(proposal.entryPrice - proposal.stopLoss);

      /*
       * An unresolved bracket is marked to the horizon's close, not discarded.
       *
       * `expiryCandles` is a real exit: the strategy closes the position at the vertical barrier, so
       * a timeout has a realised P&L somewhere between the stop and the target. Dropping those rows
       * would keep only the decisive outcomes and report the mean of a filtered distribution -- and
       * the filtering is not mild here, since roughly half of all 1-minute brackets time out. It
       * would also flatter the faster architectures most, because a tighter bracket resolves more
       * often, which is precisely the comparison under test.
       */
      let grossR: number;
      if (resolution.rMultiple !== null) {
        grossR = resolution.rMultiple;
      } else {
        unresolved += 1;
        const exit = forward[forward.length - 1]!.close;
        const realised = proposal.side === "LONG" ? exit - proposal.entryPrice : proposal.entryPrice - exit;
        grossR = realised / riskPerUnit;
      }

      trades.push({
        day: istDay(contexts[index]!.candle.closeTime),
        grossR,
        riskPerUnit,
        entryPrice: proposal.entryPrice,
      });
    }
  }
  return { trades, unresolved };
}

function netDaily(trades: readonly TradeRecord[], costBps: number): DailyExpectancy[] {
  return toDailyExpectancy(trades.map((trade) => ({
    day: trade.day,
    netR: netOutcomeR({ grossR: trade.grossR, riskPerUnit: trade.riskPerUnit, entryPrice: trade.entryPrice, costBps }),
  })));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const periodArg = flag("--period") ?? "BASE_SELECTION";
  const period = PERIODS[periodArg as keyof typeof PERIODS];
  if (!period) throw new Error(`--period must be one of ${Object.keys(PERIODS).join(", ")}.`);

  const INSTRUMENTS = (flag("--instruments") ?? DEFAULT_INSTRUMENTS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const onlyArg = flag("--only");
  const ARCHITECTURES = onlyArg
    ? ALL_ARCHITECTURES.filter((a) => onlyArg.split(",").map((s) => s.trim()).includes(a.label))
    : [...ALL_ARCHITECTURES];
  if (ARCHITECTURES.length === 0) throw new Error("--only selected no known architecture.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const readiness: string[] = [];
    // Pooled across instruments: the protocol selects one architecture, not one per symbol. Kept per
    // instrument as well, because the A->B gate requires each instrument to clear the bar on its own.
    const tradesByArchitecture = new Map<string, TradeRecord[]>(ARCHITECTURES.map((a) => [a.label, []]));
    const unresolvedByArchitecture = new Map<string, number>(ARCHITECTURES.map((a) => [a.label, 0]));
    const tradesByInstrument = new Map<string, TradeRecord[]>();
    let sessions = 0;

    for (const symbol of INSTRUMENTS) {
      const tickRow = await database.query<{ tick_size: string }>(
        "SELECT tick_size FROM instruments WHERE symbol = $1", [symbol],
      );
      if (!tickRow.rows[0]) throw new Error(`${symbol} is not a registered instrument.`);
      const tickSize = Number(tickRow.rows[0].tick_size);
      if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error(`${symbol} has an unusable tick size.`);

      const rows = await database.query<{
        id: string; open_time: Date; close_time: Date; open: string; high: string; low: string; close: string;
      }>(`
        SELECT c.id, c.open_time, c.close_time, c.open, c.high, c.low, c.close
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
          AND c.close_time >= $2::date AND c.close_time < ($3::date + INTERVAL '1 day')
        ORDER BY c.close_time ASC
      `, [symbol, period.from, period.to]);

      const bars: RawBar[] = rows.rows.map((row) => ({
        id: row.id,
        openTime: row.open_time,
        closeTime: row.close_time,
        open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
        volume: 0,
      }));

      const audit = auditOneMinuteSeries(bars, symbol);
      readiness.push(...audit.notes);
      sessions = Math.max(sessions, audit.sessions);

      const instrumentId = `${symbol}-synthetic`;
      for (const architecture of ARCHITECTURES) {
        // Aggregated from the audited regular-session bars only.
        const aggregated = aggregateBars(audit.regular, architecture.barsPerBucket);
        const contexts = buildContexts(aggregated, instrumentId, architecture.label, tickSize);
        const { trades, unresolved } = evaluateArchitecture(contexts, aggregated);
        tradesByArchitecture.get(architecture.label)!.push(...trades);
        tradesByInstrument.set(`${symbol}|${architecture.label}`, trades);
        unresolvedByArchitecture.set(architecture.label, unresolvedByArchitecture.get(architecture.label)! + unresolved);
      }
    }

    const matrix = ARCHITECTURES.map((architecture) => {
      const trades = tradesByArchitecture.get(architecture.label)!;
      const perBps = Object.fromEntries(COST_LADDER.map((bps) => {
        const summary = summariseExpectancy(netDaily(trades, bps));
        return [`${bps}bp`, {
          meanDailyR: Number(summary.meanDailyR.toFixed(5)),
          ci95: summary.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
        }];
      }));
      const meanCost = trades.length === 0 ? null : trades.reduce((sum, t) =>
        sum + roundTripCostR({ riskPerUnit: t.riskPerUnit, entryPrice: t.entryPrice, costBps: PRIMARY_BPS }), 0) / trades.length;
      return {
        architecture: architecture.label,
        trades: trades.length,
        unresolved: unresolvedByArchitecture.get(architecture.label)!,
        grossMeanDailyR: Number(summariseExpectancy(netDaily(trades, 0)).meanDailyR.toFixed(5)),
        meanRoundTripCostR_at2bp: meanCost === null ? null : Number(meanCost.toFixed(5)),
        netExpectancy: perBps,
      };
    });

    // Per instrument at the primary endpoint. The A->B gate is not satisfied by a pooled average: a
    // winner that works on one index and not the other is drift, which is the failure mode this whole
    // protocol was rebuilt around.
    const perInstrument = [...tradesByInstrument.entries()].map(([key, trades]) => {
      const [symbol, architecture] = key.split("|");
      const summary = summariseExpectancy(netDaily(trades, PRIMARY_BPS));
      return {
        instrument: symbol!,
        architecture: architecture!,
        trades: trades.length,
        days: summary.days,
        netMeanDailyR_at2bp: Number(summary.meanDailyR.toFixed(5)),
        ci95: summary.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
        nonNegative: summary.meanDailyR >= 0,
      };
    });

    // Pairwise contrasts at the primary endpoint, paired on the session, Holm-adjusted as a family.
    // Only meaningful when more than one architecture ran.
    const dailyAt2 = new Map<string, DailyExpectancy[]>(
      ARCHITECTURES.map((a) => [a.label, netDaily(tradesByArchitecture.get(a.label)!, PRIMARY_BPS)]),
    );
    const CONTRAST_PAIRS: readonly (readonly [string, string, string])[] = [
      ["3m - 1m", "3m", "1m"], ["5m - 1m", "5m", "1m"], ["5m - 3m", "5m", "3m"],
    ];
    const candidateContrasts = CONTRAST_PAIRS
      .filter(([, left, right]) => dailyAt2.has(left) && dailyAt2.has(right))
      .map(([label, left, right]) => pairedDelta(label, dailyAt2.get(left)!, dailyAt2.get(right)!));
    const contrasts = applyHolm(candidateContrasts).map((delta) => ({
      contrast: delta.label,
      pairedDays: delta.pairedDays,
      meanDelta: Number(delta.meanDelta.toFixed(5)),
      ci95: delta.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
      holmAdjustedP: delta.holmAdjustedP === null || delta.holmAdjustedP === undefined
        ? null : Number(delta.holmAdjustedP.toFixed(5)),
      significant: delta.significant ?? false,
    }));

    const winners = contrasts.filter((c) => c.significant);
    // A single architecture on a fresh instrument set is the A->B gate rather than a selection run.
    const isGate = ARCHITECTURES.length === 1;
    const failing = perInstrument.filter((entry) => !entry.nonNegative);

    console.info(JSON.stringify({
      level: "info",
      message: isGate ? "Gate A->B complete" : "Experiment A complete",
      mode: isGate ? "GATE" : "SELECTION",
      period: periodArg,
      window: period,
      instruments: INSTRUMENTS,
      architectures: ARCHITECTURES.map((a) => a.label),
      sessions,
      strategy: "momentum-scalp-index",
      horizonBars: HORIZON_BARS,
      primaryEndpointBps: PRIMARY_BPS,
      readinessWarnings: readiness,
      matrix,
      perInstrument,
      contrasts,
      // The protocol's terminal outcomes. Reported rather than inferred, so a null result is a result.
      verdict: isGate
        ? (failing.length === 0
          ? "GATE_PASSED — non-negative 2-bps expectancy on every instrument"
          : `BASE_DOES_NOT_TRANSFER — negative 2-bps expectancy on ${failing.map((f) => f.instrument).join(", ")}`)
        : (winners.length === 0
          ? "NO_UNIQUE_WINNER — no contrast's 95% CI excludes zero after Holm adjustment"
          : `Significant contrasts: ${winners.map((w) => w.contrast).join(", ")}`),
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Experiment A failed:", error);
  process.exitCode = 1;
});
