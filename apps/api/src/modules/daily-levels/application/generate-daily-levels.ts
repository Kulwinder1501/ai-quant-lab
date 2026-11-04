import { buildLevelSheet, type DailyLevelsInstrument, type LevelSheet } from "../domain/levels.js";
import type { PostgresDailyLevelsRepository } from "../../../infrastructure/database/repositories/postgres-daily-levels-repository.js";

export type GenerateStatus = "STORED" | "DRY_RUN" | "ALREADY_STORED" | "HOLIDAY" | "WEEKEND" | "NO_DATA" | "STALE_REFERENCE";

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

const PREVIOUS_SESSION_LOOKBACK_DAYS = 10;

const shiftDay = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** The last weekday before `sessionDate` that is not an NSE holiday; null when none is found within the lookback (never in practice). */
async function previousTradingSession(repository: DailyLevelsRepository, sessionDate: string): Promise<string | null> {
  for (let back = 1; back <= PREVIOUS_SESSION_LOOKBACK_DAYS; back += 1) {
    const candidate = shiftDay(sessionDate, -back);
    if (!isWeekend(candidate) && (await repository.holidayName(candidate)) === null) return candidate;
  }
  return null;
}

/**
 * Builds and stores the pre-open sheet for each index. A weekend or an NSE holiday is skipped, a session that already has a sheet is left
 * alone unless `force` (a forced run is a new version, never an overwrite), and an index with no completed daily bar before the session
 * is reported NO_DATA so the job fails loudly instead of leaving an empty page. A sheet whose newest daily bar is older than the previous
 * trading session is reported STALE_REFERENCE and never stored: every prior-day level would be a day (or more) out of date. That happened on
 * 2026-11-04, when the 11-03 end-of-day collection failed and the sheet was built on 11-02.
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

  const expectedReference = await previousTradingSession(repository, sessionDate);
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
    if (expectedReference !== null && sheet.referenceDate !== expectedReference) {
      results.push({
        underlying, status: "STALE_REFERENCE",
        detail: `newest completed daily bar is ${sheet.referenceDate}, the previous trading session was ${expectedReference}`,
      });
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
