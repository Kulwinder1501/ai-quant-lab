import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { scanCandleCoverage } from "../../modules/market-data/application/scan-candle-coverage.js";

/**
 * Surfaces silent collection gaps in the live-collected index series the same day they happen.
 *
 * The August 2026 incident was discovered by accident weeks later, through a research readiness check.
 * The gap itself was ordinary — a process died — but its silence was the real failure. This job makes a
 * gap loud: it classifies each recent completed session and exits non-zero when it finds an
 * unambiguous miss, so the miss shows up as a FAILED row in the same job-health view an operator
 * already watches, rather than surfacing months later in a backtest.
 *
 * ## What it does NOT do
 *
 * It does not backfill. Detection is the cheap, safe half; the write is a separate, opt-in job
 * (`data:heal-gaps --apply`) so a live-series repair stays a deliberate action rather than a silent
 * daily side effect. This job only tells an operator when to run it and for which sessions.
 *
 * ## Why only CONFIRMED_GAP fails the job
 *
 * `classifySessionCoverage` separates an unambiguous miss (missing open or an interior hole) from an
 * ambiguous short tail (a half-day, or an early stop). Only the former fails the run. A half-day that
 * failed the job every time it occurred would train an operator to ignore the signal, which is worse
 * than no signal.
 *
 * Usage: detect-candle-gaps [--instruments NIFTY50,BANKNIFTY] [--timeframe 1m] [--lookback-days 5]
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

  const instruments = (flag("--instruments") ?? "NIFTY50,BANKNIFTY").split(",").map((s) => s.trim()).filter(Boolean);
  const timeframe = flag("--timeframe") ?? "1m";
  const lookbackDays = Number(flag("--lookback-days") ?? "5");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const scan = await scanCandleCoverage(database, { instruments, timeframe, lookbackDays });

    const repairHint = scan.confirmed.length === 0 ? undefined : scan.confirmed.map((c) =>
      `npm run data:collect:historical -- --provider fyers --instrument ${c.instrument} `
      + `--timeframe ${timeframe} --from ${c.session} --to ${c.session} --skip-existing`);

    console.info(JSON.stringify({
      level: scan.confirmed.length > 0 ? "error" : "info",
      message: "Candle gap detection complete",
      instruments,
      timeframe,
      lookbackDays,
      sessionsChecked: scan.sessionsChecked,
      confirmedGaps: scan.confirmed.map((c) => ({ instrument: c.instrument, session: c.session, ...c.coverage })),
      // Only the ambiguous shorts are left for a human to eyeball; the confirmed ones carry the exact
      // command that repaired the August incident (or run `data:heal-gaps --apply`).
      tailShort: scan.tailShort.map((c) => ({ instrument: c.instrument, session: c.session, ...c.coverage })),
      repairHint,
    }, null, 2));

    // Non-zero exit only on an unambiguous miss, so the scheduler records it as a FAILED job and it
    // surfaces the same day. A tail-short is logged but does not fail the run.
    if (scan.confirmed.length > 0) {
      throw new Error(`${scan.confirmed.length} confirmed collection gap(s) found; see confirmedGaps and repairHint.`);
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Candle gap detection failed:", error);
  process.exitCode = 1;
});
