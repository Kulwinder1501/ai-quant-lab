import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { classifySessionCoverage } from "../../modules/market-data/domain/candle-gap-detection.js";

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
 * It does not backfill. A live-series repair is a write to the production candle series that runs
 * through the provenance guard, and doing that automatically every day is a standing write path with
 * its own failure modes. The proven manual step is `data:collect:historical`; this job tells an
 * operator when to run it and for which sessions. Detection is the cheap, safe half; the write stays a
 * deliberate human action until there is a reason to automate it.
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

const REGULAR_SESSION_BARS: Record<string, number> = { "1m": 375, "3m": 125, "5m": 75, "15m": 25 };
const SESSION_OPEN_IST_MINUTE = 9 * 60 + 15; // 09:15
const BAR_MINUTES: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15 };

function istMinuteOfDay(at: Date): number {
  return Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 60_000) % 1440;
}
function istDateKey(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

  const instruments = (flag("--instruments") ?? "NIFTY50,BANKNIFTY").split(",").map((s) => s.trim()).filter(Boolean);
  const timeframe = flag("--timeframe") ?? "1m";
  const barsExpected = REGULAR_SESSION_BARS[timeframe];
  const barMinutes = BAR_MINUTES[timeframe];
  if (barsExpected === undefined || barMinutes === undefined) {
    throw new Error(`--timeframe must be one of ${Object.keys(REGULAR_SESSION_BARS).join(", ")}.`);
  }
  const lookbackDays = Number(flag("--lookback-days") ?? "5");
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) throw new Error("--lookback-days must be a positive integer.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const confirmed: Record<string, unknown>[] = [];
    const tailShort: Record<string, unknown>[] = [];
    let sessionsChecked = 0;

    for (const symbol of instruments) {
      const rows = await database.query<{ close_time: Date }>(`
        SELECT c.close_time
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = $2 AND c.is_complete = TRUE
          -- Completed sessions only: never the in-progress day, which would always look short.
          AND c.close_time >= (CURRENT_DATE - make_interval(days => $3))
          AND c.close_time < date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
                              AT TIME ZONE 'Asia/Kolkata'
        ORDER BY c.close_time ASC
      `, [symbol, timeframe, lookbackDays]);

      const bySession = new Map<string, number[]>();
      for (const row of rows.rows) {
        // Minute-of-session index: (close-minute - open - one bar) / barMinutes. The first bar of a
        // 1m session closes at 09:16, i.e. open + 1 minute, which must map to index 0.
        const index = Math.round((istMinuteOfDay(row.close_time) - SESSION_OPEN_IST_MINUTE - barMinutes) / barMinutes);
        const day = istDateKey(row.close_time);
        // A bar outside the regular window (a Muhurat evening, say) is skipped rather than classified:
        // it does not belong to a regular-session shape, and the domain function would reject it.
        if (index < 0 || index >= barsExpected) continue;
        const bucket = bySession.get(day);
        if (bucket) bucket.push(index);
        else bySession.set(day, [index]);
      }

      for (const [day, indices] of bySession) {
        sessionsChecked += 1;
        const coverage = classifySessionCoverage({ presentMinuteIndices: indices, barsExpected });
        if (coverage.kind === "CONFIRMED_GAP") {
          confirmed.push({ instrument: symbol, session: day, timeframe, ...coverage });
        } else if (coverage.kind === "TAIL_SHORT") {
          tailShort.push({ instrument: symbol, session: day, timeframe, ...coverage });
        }
      }
    }

    const repairHint = confirmed.length === 0 ? undefined : confirmed.map((c) =>
      `npm run data:collect:historical -- --provider fyers --instrument ${c.instrument} `
      + `--timeframe ${timeframe} --from ${c.session} --to ${c.session}`);

    console.info(JSON.stringify({
      level: confirmed.length > 0 ? "error" : "info",
      message: "Candle gap detection complete",
      instruments,
      timeframe,
      lookbackDays,
      sessionsChecked,
      confirmedGaps: confirmed,
      tailShort,
      // Only the ambiguous shorts are left for a human to eyeball; the confirmed ones carry the exact
      // command that repaired the August incident.
      repairHint,
    }, null, 2));

    // Non-zero exit only on an unambiguous miss, so the scheduler records it as a FAILED job and it
    // surfaces the same day. A tail-short is logged but does not fail the run.
    if (confirmed.length > 0) {
      throw new Error(`${confirmed.length} confirmed collection gap(s) found; see confirmedGaps and repairHint.`);
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Candle gap detection failed:", error);
  process.exitCode = 1;
});
