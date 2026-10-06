import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { aggregateBars } from "../../modules/backtesting/domain/bar-aggregation.js";
import { netOutcomeR, roundTripCostR } from "../../modules/backtesting/domain/round-trip-cost.js";
import { summariseExpectancy, toDailyExpectancy } from "../../modules/backtesting/domain/expectancy-statistics.js";
import {
  buildContexts,
  evaluateArchitecture,
  type TradeRecord,
} from "../../modules/backtesting/application/architecture-evaluation.js";
import { defaultMomentumScalpIndexStrategyConfiguration }
  from "../../modules/strategy-engine/domain/momentum-scalp-index-strategy.js";
import type { CompletedPriceCandle } from "../../modules/paper-trading/domain/paper-trade-exit-policy.js";

/**
 * Sweeps `atrStopMultiple` to ask whether any bracket width leaves room for execution costs.
 *
 * Experiment A answered "which timeframe" (5m, significantly, replicated) and the A->B gate then showed
 * the answer does not matter: every arm sits below the cost line. Gross expectancy on the indices is
 * *positive* (+0.0301 R/day) while net at 2 bps is -0.35, because a 5-minute ATR stop is too tight to
 * carry the friction. Cost in R is `bps x price / riskPerUnit`, so widening the stop is the one lever
 * that reduces it without touching the signal.
 *
 * ## What to expect, and why the answer is not obvious
 *
 * Widening the stop cuts both ways, and the two effects live in different parts of the distribution:
 *
 * - For a **resolved** bracket, gross R is fixed by the reward:risk geometry (+1.5 on a target, about
 *   -1 on a stop) no matter how wide the stop is, while cost in R falls proportionally. Widening is a
 *   pure gain here.
 * - For a **timed-out** bracket, gross R is a fixed price move divided by a larger risk, so gross and
 *   cost shrink *together* and the sign of the net cannot change. Widening only scales it toward zero.
 *
 * So the sweep is really asking how the mix moves: a wider bracket resolves less often inside the same
 * `expiryCandles` horizon, trading cheap decisive outcomes for cheap indecisive ones. That is why the
 * resolved share is reported next to every row -- without it the curve is uninterpretable.
 *
 * ## This is exploratory, not confirmatory
 *
 * The A->B gate consumed the index 2026 block. Re-using it here cannot confirm anything; it can only
 * generate a hypothesis. Anything promising has to be checked on data this sweep never saw.
 *
 * Usage: run-stop-multiple-sweep [--instruments NIFTY50,BANKNIFTY] [--timeframe 5m]
 *          [--from 2026-01-01] [--to 2026-08-14] [--multiples 0.5,1,1.5,2,3,5]
 */

const CONFIG = defaultMomentumScalpIndexStrategyConfiguration;
const HORIZON_BARS = CONFIG.expiryCandles;
const PRIMARY_BPS = 2;
const COST_LADDER = [1, 2, 5] as const;

const TIMEFRAME_BUCKETS: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5 };
const REGULAR_FIRST_CLOSE = 556; // 09:16 IST
const REGULAR_LAST_CLOSE = 930;  // 15:30 IST

function istMinuteOfDay(at: Date): number {
  return Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 60_000) % 1440;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

  const instruments = (flag("--instruments") ?? "NIFTY50,BANKNIFTY").split(",").map((s) => s.trim()).filter(Boolean);
  const timeframe = flag("--timeframe") ?? "5m";
  const barsPerBucket = TIMEFRAME_BUCKETS[timeframe];
  if (barsPerBucket === undefined) throw new Error(`--timeframe must be one of ${Object.keys(TIMEFRAME_BUCKETS).join(", ")}.`);
  const from = flag("--from") ?? "2026-01-01";
  const to = flag("--to") ?? "2026-08-14";
  const multiples = (flag("--multiples") ?? "0.5,1,1.5,2,3,5").split(",").map((s) => Number(s.trim()));
  if (multiples.some((m) => !Number.isFinite(m) || m <= 0)) throw new Error("--multiples must all be positive numbers.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    // Bars and indicators do not depend on the stop multiple, so they are built once per instrument and
    // reused across every multiple. Rebuilding them per multiple would multiply a several-minute run by
    // the length of the sweep for no change in input.
    const series: { symbol: string; bars: CompletedPriceCandle[]; tickSize: number }[] = [];
    const notes: string[] = [];

    for (const symbol of instruments) {
      const tickRow = await database.query<{ tick_size: string }>(
        "SELECT tick_size FROM instruments WHERE symbol = $1", [symbol],
      );
      if (!tickRow.rows[0]) throw new Error(`${symbol} is not a registered instrument.`);
      const tickSize = Number(tickRow.rows[0].tick_size);

      const rows = await database.query<{
        id: string; open_time: Date; close_time: Date; open: string; high: string; low: string; close: string;
      }>(`
        SELECT c.id, c.open_time, c.close_time, c.open, c.high, c.low, c.close
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
          AND c.close_time >= $2::date AND c.close_time < ($3::date + INTERVAL '1 day')
        ORDER BY c.close_time ASC
      `, [symbol, from, to]);
      if (rows.rows.length === 0) throw new Error(`${symbol}: no 1m bars between ${from} and ${to}.`);

      const seen = new Set<number>();
      const regular: CompletedPriceCandle[] = [];
      let excluded = 0;
      for (const row of rows.rows) {
        const stamp = row.close_time.getTime();
        if (seen.has(stamp)) throw new Error(`${symbol}: duplicate 1m bar at ${row.close_time.toISOString()}.`);
        seen.add(stamp);
        const minute = istMinuteOfDay(row.close_time);
        if (minute < REGULAR_FIRST_CLOSE || minute > REGULAR_LAST_CLOSE) { excluded += 1; continue; }
        regular.push({
          id: row.id,
          openTime: row.open_time,
          closeTime: row.close_time,
          open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
        });
      }
      if (excluded > 0) notes.push(`${symbol}: excluded ${excluded} bar(s) outside 09:16-15:30 IST.`);

      series.push({ symbol, bars: aggregateBars(regular, barsPerBucket), tickSize });
    }

    const curve = multiples.map((multiple) => {
      const configuration = { ...CONFIG, atrStopMultiple: multiple } as unknown as Record<string, unknown>;
      const perInstrument: Record<string, unknown> = {};
      const pooled: TradeRecord[] = [];
      let timeouts = 0;

      for (const entry of series) {
        const contexts = buildContexts({
          bars: entry.bars,
          instrumentId: `${entry.symbol}-synthetic`,
          timeframe,
          tickSize: entry.tickSize,
          config: CONFIG,
        });
        const result = evaluateArchitecture({
          contexts, bars: entry.bars, configuration, horizonBars: HORIZON_BARS,
        });
        pooled.push(...result.trades);
        timeouts += result.timeouts;

        const summary = summariseExpectancy(toDailyExpectancy(result.trades.map((t) => ({
          day: t.day,
          netR: netOutcomeR({ grossR: t.grossR, riskPerUnit: t.riskPerUnit, entryPrice: t.entryPrice, costBps: PRIMARY_BPS }),
        }))));
        perInstrument[entry.symbol] = {
          trades: result.trades.length,
          netMeanDailyR_at2bp: Number(summary.meanDailyR.toFixed(5)),
          ci95: summary.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
          nonNegative: summary.meanDailyR >= 0,
        };
      }

      const netAt = (bps: number) => summariseExpectancy(toDailyExpectancy(pooled.map((t) => ({
        day: t.day,
        netR: netOutcomeR({ grossR: t.grossR, riskPerUnit: t.riskPerUnit, entryPrice: t.entryPrice, costBps: bps }),
      }))));
      const gross = netAt(0);
      const primary = netAt(PRIMARY_BPS);
      const meanCost = pooled.length === 0 ? null : pooled.reduce((sum, t) =>
        sum + roundTripCostR({ riskPerUnit: t.riskPerUnit, entryPrice: t.entryPrice, costBps: PRIMARY_BPS }), 0) / pooled.length;

      return {
        atrStopMultiple: multiple,
        trades: pooled.length,
        // The mix is what makes the curve interpretable; see the header.
        resolvedShare: pooled.length === 0 ? null : Number((pooled.filter((t) => t.resolved).length / pooled.length).toFixed(4)),
        timeouts,
        meanRiskPerUnit: pooled.length === 0 ? null
          : Number((pooled.reduce((s, t) => s + t.riskPerUnit, 0) / pooled.length).toFixed(4)),
        grossMeanDailyR: Number(gross.meanDailyR.toFixed(5)),
        meanRoundTripCostR_at2bp: meanCost === null ? null : Number(meanCost.toFixed(5)),
        netMeanDailyR_at2bp: Number(primary.meanDailyR.toFixed(5)),
        ci95_at2bp: primary.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
        netByBps: Object.fromEntries(COST_LADDER.map((bps) => [`${bps}bp`, Number(netAt(bps).meanDailyR.toFixed(5))])),
        perInstrument,
      };
    });

    // A candidate must clear zero on the pooled series *and* on every instrument, with the pooled
    // interval entirely above zero. Anything less is drift or noise.
    const candidates = curve.filter((row) =>
      row.ci95_at2bp !== null && row.ci95_at2bp[0]! > 0
      && Object.values(row.perInstrument).every((entry) => (entry as { nonNegative: boolean }).nonNegative));

    console.info(JSON.stringify({
      level: "info",
      message: "Stop-multiple sweep complete",
      status: "EXPLORATORY — this window was already consumed by the A->B gate; findings need untouched data",
      instruments,
      timeframe,
      window: { from, to },
      horizonBars: HORIZON_BARS,
      primaryEndpointBps: PRIMARY_BPS,
      readinessNotes: notes,
      curve,
      verdict: candidates.length === 0
        ? "NO_VIABLE_STOP_MULTIPLE — no width clears zero at 2 bps on every instrument with a CI above zero"
        : `Candidate multiples: ${candidates.map((c) => c.atrStopMultiple).join(", ")} (exploratory)`,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Stop-multiple sweep failed:", error);
  process.exitCode = 1;
});
