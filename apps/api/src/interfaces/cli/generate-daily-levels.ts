import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresDailyLevelsRepository } from "../../infrastructure/database/repositories/postgres-daily-levels-repository.js";
import { generateDailyLevels } from "../../modules/daily-levels/application/generate-daily-levels.js";
import type { DailyLevelsInstrument } from "../../modules/daily-levels/domain/levels.js";
import { istDateKey } from "../../modules/market-data/domain/nse-session-calendar.js";

/**
 * Builds and stores the pre-open levels sheet for NIFTY50 and BANKNIFTY (see docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md).
 *
 *   --date YYYY-MM-DD     the session to build for; default today (IST)
 *   --underlying NAME     NIFTY50 or BANKNIFTY; default both
 *   --force               build a new version although a sheet exists (never overwrites)
 *   --dry-run             build and print, store nothing
 *
 * Exits non-zero when an index has no data to build from, so the scheduled job is recorded FAILED instead of leaving an empty page.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTRUMENTS: readonly DailyLevelsInstrument[] = ["NIFTY50", "BANKNIFTY"];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const date = argument("--date") ?? istDateKey(new Date());
  if (!DATE_PATTERN.test(date)) throw new Error("--date must be YYYY-MM-DD");
  const requested = argument("--underlying");
  if (requested !== undefined && !INSTRUMENTS.includes(requested as DailyLevelsInstrument)) throw new Error("--underlying must be NIFTY50 or BANKNIFTY");
  const underlyings = requested === undefined ? INSTRUMENTS : [requested as DailyLevelsInstrument];

  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const results = await generateDailyLevels(new PostgresDailyLevelsRepository(database), date, underlyings, {
      force: process.argv.includes("--force"),
      dryRun: process.argv.includes("--dry-run"),
    });
    for (const result of results) {
      console.info(JSON.stringify({
        level: result.status === "NO_DATA" ? "error" : "info",
        message: "Daily levels",
        sessionDate: date,
        underlying: result.underlying,
        status: result.status,
        version: result.version,
        detail: result.detail,
        zones: result.sheet?.zones.length,
        referencePrice: result.sheet?.referencePrice,
        unavailable: result.sheet?.unavailable,
        ...(process.argv.includes("--dry-run") ? { sheet: result.sheet } : {}),
      }));
    }
    if (results.some((result) => result.status === "NO_DATA")) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", message: "Daily levels failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
