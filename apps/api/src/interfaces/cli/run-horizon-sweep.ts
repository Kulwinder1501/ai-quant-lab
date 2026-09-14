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
 * Sweeps the holding-period horizon (`expiryCandles`) to ask whether *any* holding period lets the
 * signal earn enough gross edge to pay execution costs.
 *
 * The stop-multiple sweep varied bracket *width* and returned NO_VIABLE_STOP_MULTIPLE: cost in R falls
 * as 1/width, but gross edge (+0.0301 R/day) was too small by ~13x, and widening only scaled the timed-
 * out mass toward zero. It left one lever untouched — how long a bracket is allowed to run before it is
 * marked out. This sweep is that lever.
 *
 * ## Why horizon is a genuinely different knob from stop width
 *
 * Cost in R is `bps x price / riskPerUnit`. Neither term depends on the horizon: riskPerUnit is fixed
 * by the ATR stop, and entry price is the entry price. So lengthening the horizon changes the *outcome*
 * mix without changing the per-trade cost at all — unlike stop width, which moved cost and the timed-out
 * mass together. Concretely:
 *
 * - A **timed-out** bracket carries a fixed price move divided by a fixed risk: a small, noisy number
 *   centred near zero. It is a bet the signal never resolved.
 * - Extending the horizon gives more of those brackets the room to actually hit a stop or a target, at
 *   which point their gross R snaps to the geometry (+1.5 on a target, about -1 on a stop).
 *
 * So the sweep asks the one question the stop sweep could not: when the signal is given room to play
 * out, do the resolved outcomes come in *above* the reward:risk-weighted break-even (a hit rate beating
 * 1 / (1 + rewardRisk) = 40%)? If the resolved share climbs but net stays pinned below zero, the signal
 * does not predict a move large enough to pay friction at any holding period, and the momentum-scalp
 * architecture on the indices is finished — not merely mis-tuned. If net crosses zero at some horizon,
 * that is a hypothesis (never a conclusion here; see below) worth checking on untouched data.
 *
 * The resolved share is reported next to every row, because the whole curve is a statement about how
 * the outcome mix moves — without it the net is uninterpretable.
 *
 * ## This is exploratory, not confirmatory
 *
 * The A->B gate already consumed the index 2026 block, and the stop sweep re-used it too. Re-using it a
 * third time cannot confirm anything; it can only generate or kill a hypothesis. Anything that looks
 * alive here has to be checked on data this sweep never saw.
 *
 * Usage: run-horizon-sweep [--instruments NIFTY50,BANKNIFTY] [--timeframe 5m]
 *          [--from 2026-01-01] [--to 2026-08-14] [--horizons 3,5,10,20,40,75]
 */

const CONFIG = defaultMomentumScalpIndexStrategyConfiguration;
const PRIMARY_BPS = 2;
const COST_LADDER = [1, 2, 5] as const;
// Break-even hit rate for the reward:risk geometry: below this share of targets, the resolved leg loses
// gross. Reported so a rising resolved share can be read against the bar it must clear.
const BREAKEVEN_HIT_RATE = 1 / (1 + CONFIG.rewardRiskMultiple);

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
  const horizons = (flag("--horizons") ?? "3,5,10,20,40,75").split(",").map((s) => Number(s.trim()));
  if (horizons.some((h) => !Number.isInteger(h) || h <= 0)) throw new Error("--horizons must all be positive integers.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    // Bars and indicators do not depend on the horizon, so they are built once per instrument and reused
    // across every horizon. Rebuilding them per horizon would multiply a several-minute run for no change
    // in input — the horizon only changes how far forward each resolved bracket is allowed to look.
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

    const curve = horizons.map((horizonBars) => {
      // expiryCandles only stamps proposal metadata; the horizon that actually governs resolution is the
      // forward-slice length passed as horizonBars. Kept in sync so the configuration reads honestly.
      const configuration = { ...CONFIG, expiryCandles: horizonBars } as unknown as Record<string, unknown>;
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
          contexts, bars: entry.bars, configuration, horizonBars,
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

      // Of the brackets that actually resolved, the share that hit the target rather than the stop. This
      // is the number that has to clear BREAKEVEN_HIT_RATE for the resolved leg to carry positive gross.
      const resolved = pooled.filter((t) => t.resolved);
      const targetHits = resolved.filter((t) => t.grossR > 0).length;

      return {
        expiryCandles: horizonBars,
        trades: pooled.length,
        resolvedShare: pooled.length === 0 ? null : Number((resolved.length / pooled.length).toFixed(4)),
        resolvedTargetHitRate: resolved.length === 0 ? null : Number((targetHits / resolved.length).toFixed(4)),
        timeouts,
        grossMeanDailyR: Number(gross.meanDailyR.toFixed(5)),
        meanRoundTripCostR_at2bp: meanCost === null ? null : Number(meanCost.toFixed(5)),
        netMeanDailyR_at2bp: Number(primary.meanDailyR.toFixed(5)),
        ci95_at2bp: primary.ci95?.map((v) => Number(v.toFixed(5))) ?? null,
        netByBps: Object.fromEntries(COST_LADDER.map((bps) => [`${bps}bp`, Number(netAt(bps).meanDailyR.toFixed(5))])),
        perInstrument,
      };
    });

    // A candidate must clear zero on the pooled series *and* on every instrument, with the pooled interval
    // entirely above zero. Anything less is drift or noise on a thrice-reused window.
    const candidates = curve.filter((row) =>
      row.ci95_at2bp !== null && row.ci95_at2bp[0]! > 0
      && Object.values(row.perInstrument).every((entry) => (entry as { nonNegative: boolean }).nonNegative));

    console.info(JSON.stringify({
      level: "info",
      message: "Horizon (expiryCandles) sweep complete",
      status: "EXPLORATORY — this window was already consumed by the A->B gate and the stop sweep; findings need untouched data",
      instruments,
      timeframe,
      window: { from, to },
      primaryEndpointBps: PRIMARY_BPS,
      rewardRiskMultiple: CONFIG.rewardRiskMultiple,
      breakevenResolvedHitRate: Number(BREAKEVEN_HIT_RATE.toFixed(4)),
      readinessNotes: notes,
      curve,
      verdict: candidates.length === 0
        ? "NO_VIABLE_HORIZON — no holding period clears zero at 2 bps on every instrument with a CI above zero"
        : `Candidate horizons: ${candidates.map((c) => c.expiryCandles).join(", ")} (exploratory)`,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Horizon sweep failed:", error);
  process.exitCode = 1;
});
