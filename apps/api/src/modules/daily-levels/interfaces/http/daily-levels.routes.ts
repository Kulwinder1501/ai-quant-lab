import type { Express } from "express";
import type { DatabaseQueryable } from "../../../../infrastructure/database/database.js";
import {
  PostgresDailyLevelsRepository,
  type StoredLevelSheet,
  type StoredStudy,
} from "../../../../infrastructure/database/repositories/postgres-daily-levels-repository.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import type { DailyLevelsInstrument } from "../../domain/levels.js";
import { CONFLUENCE_COMPARISON_LABEL, describeReaction } from "../../domain/reaction-study.js";

export const LEVELS_DISCLAIMER =
  "Context, not a signal. These are levels traders commonly watch, computed from stored data before the open. "
  + "Nothing here says price will bounce, and no bot reads this sheet.";

export const HISTORY_CAVEAT =
  "Measured on 15-minute bars from 2023 against four displaced placebo lines per level. Every class, placebo included, shows a bounce share above 50% "
  + "because a touch is measured from the line itself while the touch bar has often already moved away from it; the comparison with placebo lines "
  + "cancels that. There are fourteen comparisons here, so about one in twenty would exclude zero by chance alone, and a difference smaller than roughly "
  + "five points cannot be ruled out.";

const INSTRUMENTS: readonly DailyLevelsInstrument[] = ["NIFTY50", "BANKNIFTY"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DailyLevelsQuery =
  | { ok: true; value: { underlying: DailyLevelsInstrument; date: string | null } }
  | { ok: false; error: string };

export function parseDailyLevelsQuery(input: { underlying: string | undefined; date: string | undefined }): DailyLevelsQuery {
  if (input.underlying === undefined || !INSTRUMENTS.includes(input.underlying as DailyLevelsInstrument)) {
    return { ok: false, error: "underlying must be NIFTY50 or BANKNIFTY." };
  }
  if (input.date !== undefined && !DATE_PATTERN.test(input.date)) return { ok: false, error: "date must be YYYY-MM-DD." };
  return { ok: true, value: { underlying: input.underlying as DailyLevelsInstrument, date: input.date ?? null } };
}

/** The response body: the stored sheet, and the study beside it with its sentences written server-side so every client says the same thing. */
export function buildDailyLevelsResponse(underlying: DailyLevelsInstrument, stored: StoredLevelSheet | null, study: StoredStudy | null) {
  if (stored === null) {
    return { available: false as const, underlying, reason: "No levels sheet has been generated for this index yet.", disclaimer: LEVELS_DISCLAIMER };
  }
  const { sheet } = stored;
  return {
    available: true as const,
    underlying,
    sessionDate: sheet.sessionDate,
    referenceDate: sheet.referenceDate,
    referencePrice: sheet.referencePrice,
    version: stored.version,
    generatedAt: stored.generatedAt,
    zones: sheet.zones,
    unavailable: sheet.unavailable,
    oi: sheet.oi,
    history: study === null
      ? null
      : {
          studyVersion: study.studyVersion,
          computedAt: study.computedAt,
          windowFrom: study.windowFrom,
          windowTo: study.windowTo,
          sessionsUsed: study.payload.sessionsUsed,
          sessionsSkipped: study.payload.sessionsSkipped,
          comparisons: study.payload.summaries.map((summary) => ({ ...summary, sentence: describeReaction(summary) })),
          confluence: study.payload.confluence === null
            ? null
            : { ...study.payload.confluence, sentence: describeReaction(study.payload.confluence, CONFLUENCE_COMPARISON_LABEL) },
          caveat: HISTORY_CAVEAT,
        },
    disclaimer: LEVELS_DISCLAIMER,
  };
}

/** `GET /api/v1/daily-levels?underlying=NIFTY50&date=YYYY-MM-DD` (date optional: the latest sheet). Read-only. */
export function registerDailyLevelsRoutes(app: Express, database: DatabaseQueryable): void {
  const repository = new PostgresDailyLevelsRepository(database);
  app.get("/api/v1/daily-levels", async (request, response, next) => {
    try {
      const parsed = parseDailyLevelsQuery({ underlying: queryString(request, "underlying"), date: queryString(request, "date") });
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, date } = parsed.value;
      const [stored, study] = await Promise.all([repository.latestSheet(underlying, date), repository.latestStudy(underlying)]);
      response.status(200).json({ data: buildDailyLevelsResponse(underlying, stored, study) });
    } catch (error) {
      next(error);
    }
  });
}
