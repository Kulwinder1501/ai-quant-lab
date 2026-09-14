import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresDepthFrameRepository } from "../../infrastructure/database/repositories/postgres-depth-frame-repository.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import {
  DEPTH_CAPTURE_SEGMENT,
  DEPTH_STRUCTURAL_SILENCE_MS,
  describeContractRoll,
  evaluateDepthCaptureStaleness,
} from "../../modules/market-data/domain/depth-frame-staleness.js";

/**
 * Makes a silent depth-capture outage loud, the same session it happens.
 *
 * This is `detect-candle-gaps` for `depth_frames`, and it exists because the depth feed's failure is
 * strictly worse than a candle gap: candles have a repair path and the order book has none. An L2
 * update not received when it happened is permanently lost, so this runs every ten minutes during the
 * session rather than once after the close.
 *
 * ## Why an out-of-process check, when the collector already has a staleness guard
 *
 * It does, and on 2026-08-26 it worked exactly as designed -- `collect-depth-frames` logged
 * `"No depth frames during market hours; the subscription may be dead."` every five minutes for two
 * full sessions. Nobody saw it. It went to a container's stderr, and nothing polls a container's
 * stderr; the incident was found by a human noticing a row count had stopped moving.
 *
 * The in-process guard cannot fix that, because the thing that needs to be noticed is the collector
 * itself, and a process is the worst possible witness to its own absence. It also cannot report at
 * all in the cases that matter most -- a crashed container, an OOM kill, a collector that was never
 * started after a deploy -- because in all of them there is no process left to log anything.
 *
 * So this asks the question from outside, against the table, and reports through the channel an
 * operator already watches: a non-zero exit becomes a FAILED row in `scheduled_job_runs`, which
 * surfaces in `GET /api/v1/health/jobs`. The in-process heartbeat stays; it is the faster signal for
 * someone already reading logs. This is the one that survives the collector dying.
 *
 * ## It names no symbol, deliberately
 *
 * See `depth-frame-staleness.ts`: a checker that hardcoded the front-month contract would roll into
 * the very bug it detects. The scheduled invocation passes no `--symbols` and asserts only that depth
 * capture is producing rows during market hours. `--symbols` exists for a targeted manual check.
 *
 * Usage: check-depth-frame-staleness [--symbols NSE:BANKNIFTY26SEPFUT,...]
 *                                    [--stale-after-seconds 300] [--lookback-days 10]
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

  const expectedSymbols = (flag("--symbols") ?? "")
    .split(",").map((s) => s.trim()).filter((s) => s !== "");
  const staleAfterSeconds = Number(flag("--stale-after-seconds")
    ?? String(DEPTH_STRUCTURAL_SILENCE_MS / 1_000));
  // Only used to find the last contract we captured, for the roll hint. The staleness verdict itself
  // reads the newest frame, so widening this cannot make a stale capture look healthy.
  const lookbackDays = Number(flag("--lookback-days") ?? "10");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const now = new Date();
    const repository = new PostgresDepthFrameRepository(database);
    const marketSession = new NseMarketSession(
      (process.env.NSE_HOLIDAYS ?? "").split(",").map((d) => d.trim()).filter((d) => d !== ""),
      DEPTH_CAPTURE_SEGMENT,
    );
    const session = marketSession.getSession(now, DEPTH_CAPTURE_SEGMENT);

    // One structural-silence window is all the verdict needs; anything older is stale by definition.
    const observations = await repository.summariseSymbols({
      from: new Date(now.getTime() - staleAfterSeconds * 1_000),
      to: now,
    });

    const status = evaluateDepthCaptureStaleness({
      now,
      session,
      observations: observations.map((o) => ({
        providerSymbol: o.providerSymbol,
        frames: o.frames,
        lastFrameAt: o.lastAt,
      })),
      expectedSymbols,
      structuralSilenceMs: staleAfterSeconds * 1_000,
    });

    // Only worth the extra queries when something is actually wrong.
    let rollHint: ReturnType<typeof describeContractRoll> = null;
    if (status.status === "SILENT" || status.status === "STALE") {
      const recent = await repository.summariseSymbols({
        from: new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1_000),
        to: now,
      });
      const lastCaptured = recent
        .slice()
        .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())[0]?.providerSymbol;
      if (lastCaptured !== undefined) {
        const parsedUnderlying = lastCaptured.replace(/^[A-Z]+:/, "").replace(/\d{2}[A-Z]{3}FUT$/, "");
        const expiries = await database.query<{ expiry_date: string }>(
          `SELECT DISTINCT to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
           FROM option_expiry_calendar
           WHERE underlying_symbol = $1
           ORDER BY expiry_date`,
          [parsedUnderlying],
        );
        rollHint = describeContractRoll({
          lastCapturedSymbol: lastCaptured,
          now,
          expiries: expiries.rows.map((row) => row.expiry_date),
        });
      }
    }

    const failing = status.status === "SILENT" || status.status === "STALE";
    console.info(JSON.stringify({
      level: failing ? "error" : "info",
      message: "Depth frame staleness check complete",
      status: status.status,
      checkedAt: status.checkedAt.toISOString(),
      marketOpen: session !== null,
      silentForSeconds: status.silentForMs === null ? null : Math.round(status.silentForMs / 1_000),
      staleAfterSeconds,
      findings: status.findings,
      expectedSymbols,
      missingSymbols: status.missingSymbols,
      staleSymbols: status.staleSymbols,
      observed: status.observedSymbols.map((o) => ({
        providerSymbol: o.providerSymbol,
        frames: o.frames,
        lastFrameAt: o.lastFrameAt.toISOString(),
      })),
      rollHint,
      // depth_frames has no heal path. Saying so here means the operator reads it at the moment the
      // decision is made, rather than assuming a nightly repair will cover it as it does for candles.
      note: failing
        ? "Depth frames CANNOT be backfilled. Every minute this stays broken is permanently lost."
        : undefined,
    }, null, 2));

    if (failing) {
      throw new Error(
        `Depth capture is ${status.status} during market hours: ${status.findings.join(", ")}.`,
      );
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Depth frame staleness check failed:", error);
  process.exitCode = 1;
});
