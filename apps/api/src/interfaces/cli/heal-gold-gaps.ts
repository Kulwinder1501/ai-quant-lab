import "dotenv/config";
import { spawnSync } from "node:child_process";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  chunkMissingRange,
  scanXauGaps,
  type MissingXauRange,
} from "../../modules/market-data/application/scan-xau-gaps.js";

/**
 * Backfills holes in the XAU_USD 1m series that the regular 15-minute collection tick cannot reach.
 *
 * That tick only ever fetches the last 45 minutes, so whenever the host sleeps or the scheduler is
 * down for longer than that, the missed bars stay missing for good -- measured 2026-10-11: Friday
 * 15:15-21:00 UTC and 11 hours of Oct 8 were absent from `candles`. The 5m/15m series and the
 * indicators the gold strategies read are all derived from this 1m series, so the hole propagates.
 *
 * Mirrors `data:heal-gaps` (the index healer) in its safety properties:
 *
 * 1. **Dry-run unless `--apply`.** Without the flag it only prints the missing ranges.
 * 2. **Append-only.** Every fetch uses `--skip-existing`, so it can add missing minutes but never
 *    revise a stored bar.
 * 3. **Session-aware.** A "gap" is only a missing minute while gold is actually trading; the weekend
 *    close and the daily 17:00-18:00 New York break are never reported.
 * 4. **Derives and recomputes only when something was healed**, over the healed window, so an hourly
 *    run that finds nothing costs one cheap query.
 *
 * A range the provider has no bars for (a holiday early close) stays missing and is reported as
 * `stillMissing`; that is logged, not failed, so a venue closure cannot make the job fail forever.
 * A fetch/derive/indicator command that actually errors does fail the run.
 *
 * Usage: heal-gold-gaps [--apply] [--lookback-days 7] [--min-gap-minutes 5]
 *                       [--tail-grace-minutes 30] [--max-chunk-minutes 4000]
 */

const MINUTE_MS = 60_000;
const HIGHER_TIMEFRAME_MARGIN_MINUTES = 15;

function npmRun(args: string[]): void {
  const result = spawnSync("npm", ["run", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`npm run ${args.join(" ")} exited with status ${String(result.status)}`);
  }
}

function summarizeRange(range: MissingXauRange): Record<string, unknown> {
  return { from: range.from.toISOString(), to: range.to.toISOString(), minutes: range.minutes };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const apply = argv.includes("--apply");
  const lookbackDays = Number(flag("--lookback-days") ?? "7");
  const minMissingMinutes = Number(flag("--min-gap-minutes") ?? "5");
  const tailGraceMinutes = Number(flag("--tail-grace-minutes") ?? "30");
  const maxChunkMinutes = Number(flag("--max-chunk-minutes") ?? "4000");

  if (![lookbackDays, minMissingMinutes, tailGraceMinutes, maxChunkMinutes].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("--lookback-days, --min-gap-minutes, --tail-grace-minutes and --max-chunk-minutes must be positive numbers.");
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const scanOptions = { lookbackDays, minMissingMinutes, tailGraceMinutes };
    const before = await scanXauGaps(database, scanOptions);
    const chunks = before.flatMap((range) => chunkMissingRange(range, maxChunkMinutes));

    if (chunks.length === 0) {
      console.info(JSON.stringify({ level: "info", message: "XAU_USD gap heal: nothing to do", mode: apply ? "apply" : "dry-run", lookbackDays }));
      return;
    }

    if (!apply) {
      console.info(JSON.stringify({
        level: "info",
        message: "XAU_USD gap heal plan (dry-run -- pass --apply to backfill)",
        mode: "dry-run",
        lookbackDays,
        missingRanges: before.map(summarizeRange),
        fetches: chunks.length,
      }, null, 2));
      return;
    }

    if (!process.env.OANDA_ACCESS_TOKEN) {
      throw new Error("OANDA_ACCESS_TOKEN is not set; cannot fetch the missing XAU_USD bars.");
    }

    for (const chunk of chunks) {
      console.info(JSON.stringify({ level: "info", message: "Fetching missing XAU_USD 1m bars", ...summarizeRange(chunk) }));
      npmRun([
        "data:collect:historical", "--workspace", "@ai-quant-lab/api", "--",
        "--provider", "oanda", "--exchange", "OANDA", "--instrument", "XAU_USD", "--timeframe", "1m",
        "--from", chunk.from.toISOString(),
        "--to", new Date(chunk.to.getTime() + MINUTE_MS).toISOString(),
        "--skip-existing",
      ]);
    }

    const after = await scanXauGaps(database, scanOptions);
    const missingBefore = before.reduce((sum, range) => sum + range.minutes, 0);
    const missingAfter = after.reduce((sum, range) => sum + range.minutes, 0);
    const healedMinutes = missingBefore - missingAfter;

    if (healedMinutes > 0) {
      const windowFrom = new Date(Math.min(...chunks.map((c) => c.from.getTime())));
      const windowTo = new Date(Math.max(...chunks.map((c) => c.to.getTime())));
      const margin = HIGHER_TIMEFRAME_MARGIN_MINUTES * MINUTE_MS;
      const deriveTo = new Date(Math.min(windowTo.getTime() + margin, Date.now()));

      npmRun([
        "data:derive:higher-timeframes", "--workspace", "@ai-quant-lab/api", "--",
        "--exchange", "OANDA", "--instrument", "XAU_USD", "--timeframes", "5,15",
        "--from", new Date(windowFrom.getTime() - margin).toISOString(),
        "--to", deriveTo.toISOString(),
      ]);
      for (const timeframe of ["1m", "5m", "15m"]) {
        npmRun([
          "analysis:calculate-indicators", "--workspace", "@ai-quant-lab/api", "--",
          "--exchange", "OANDA", "--instrument", "XAU_USD", "--timeframe", timeframe,
          "--from", windowFrom.toISOString(),
        ]);
      }
    }

    console.info(JSON.stringify({
      level: after.length === 0 ? "info" : "warn",
      message: "XAU_USD gap heal complete",
      mode: "apply",
      lookbackDays,
      missingMinutesBefore: missingBefore,
      healedMinutes,
      // Ranges the provider returned no bars for (e.g. a holiday early close); left as-is, retried next run.
      stillMissing: after.map(summarizeRange),
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("XAU_USD gap heal failed:", error);
  process.exitCode = 1;
});
