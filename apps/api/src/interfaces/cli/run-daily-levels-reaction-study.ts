import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresDailyLevelsRepository } from "../../infrastructure/database/repositories/postgres-daily-levels-repository.js";
import { STUDY_VERSION, runReactionStudy } from "../../modules/daily-levels/application/run-reaction-study.js";
import type { DailyLevelsInstrument } from "../../modules/daily-levels/domain/levels.js";
import { CONFLUENCE_COMPARISON_LABEL, describeReaction } from "../../modules/daily-levels/domain/reaction-study.js";
import { istDateKey } from "../../modules/market-data/domain/nse-session-calendar.js";

/**
 * Runs the placebo-controlled reaction study of the daily levels exactly as fixed in
 * docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md and prints one JSON line per index. Read-only unless `--write`, which also
 * stores each result in daily_level_study_results.
 *
 *   --from YYYY-MM-DD   first session; default 2023-01-02 (the protocol's window)
 *   --to YYYY-MM-DD     last session; default yesterday (IST)
 *   --write             store the results
 */
const INSTRUMENTS: readonly DailyLevelsInstrument[] = ["NIFTY50", "BANKNIFTY"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function yesterday(): string {
  const [year, month, day] = istDateKey(new Date()).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const from = argument("--from") ?? "2023-01-02";
  const to = argument("--to") ?? yesterday();
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) throw new Error("--from and --to must be YYYY-MM-DD");
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const repository = new PostgresDailyLevelsRepository(database);
    for (const underlying of INSTRUMENTS) {
      const [dailyBars, sessions] = await Promise.all([repository.dailyBars(underlying), repository.sessionBars15m(underlying, from, to)]);
      const payload = runReactionStudy(underlying, dailyBars, sessions);
      if (process.argv.includes("--write")) await repository.saveStudy(STUDY_VERSION, from, to, payload);
      console.info(JSON.stringify({
        level: "info",
        message: "Daily levels reaction study",
        studyVersion: STUDY_VERSION,
        underlying, from, to,
        written: process.argv.includes("--write"),
        sessionsUsed: payload.sessionsUsed,
        sessionsSkipped: payload.sessionsSkipped,
        realLevelTouches: payload.realLevelTouches,
        summaries: payload.summaries.map((summary) => ({ ...summary, sentence: describeReaction(summary) })),
        confluence: payload.confluence === null ? null : { ...payload.confluence, sentence: describeReaction(payload.confluence, CONFLUENCE_COMPARISON_LABEL) },
      }));
    }
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", message: "Reaction study failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
