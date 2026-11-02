import { buildLevelSheet, type DailyLevelsInstrument, type LevelSheet } from "../domain/levels.js";
import type { PostgresDailyLevelsRepository } from "../../../infrastructure/database/repositories/postgres-daily-levels-repository.js";

export type GenerateStatus = "STORED" | "DRY_RUN" | "ALREADY_STORED" | "HOLIDAY" | "WEEKEND" | "NO_DATA";

export interface GenerateResult {
  readonly underlying: DailyLevelsInstrument;
  readonly status: GenerateStatus;
  readonly version?: number;
  readonly detail?: string;
  readonly sheet?: LevelSheet;
}

export type DailyLevelsRepository = Pick<
  PostgresDailyLevelsRepository,
  "dailyBars" | "oiBeforeOpen" | "holidayName" | "hasSheet" | "saveSheet"
>;

const isWeekend = (date: string): boolean => {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
};

/**
 * Builds and stores the pre-open sheet for each index. A weekend or an NSE holiday is skipped, a session that already has a sheet is left
 * alone unless `force` (a forced run is a new version, never an overwrite), and an index with no completed daily bar before the session
 * is reported NO_DATA so the job fails loudly instead of leaving an empty page.
 */
export async function generateDailyLevels(
  repository: DailyLevelsRepository,
  sessionDate: string,
  underlyings: readonly DailyLevelsInstrument[],
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<GenerateResult[]> {
  if (isWeekend(sessionDate)) return underlyings.map((underlying) => ({ underlying, status: "WEEKEND" as const }));
  const holiday = await repository.holidayName(sessionDate);
  if (holiday !== null) return underlyings.map((underlying) => ({ underlying, status: "HOLIDAY" as const, detail: holiday }));

  const results: GenerateResult[] = [];
  for (const underlying of underlyings) {
    if (!options.force && !options.dryRun && (await repository.hasSheet(underlying, sessionDate))) {
      results.push({ underlying, status: "ALREADY_STORED" });
      continue;
    }
    const [dailyBars, oi] = await Promise.all([repository.dailyBars(underlying), repository.oiBeforeOpen(underlying, sessionDate)]);
    const sheet = buildLevelSheet({
      underlying, sessionDate, dailyBars,
      oiStrikes: oi?.strikes ?? null, oiObservedAt: oi?.observedAt ?? null, oiExpiry: oi?.expiry ?? null,
    });
    if (sheet === null) {
      results.push({ underlying, status: "NO_DATA", detail: "no completed daily bar before the session" });
      continue;
    }
    if (options.dryRun) {
      results.push({ underlying, status: "DRY_RUN", sheet });
      continue;
    }
    const stored = await repository.saveSheet(sheet);
    results.push({ underlying, status: "STORED", version: stored.version, sheet });
  }
  return results;
}
