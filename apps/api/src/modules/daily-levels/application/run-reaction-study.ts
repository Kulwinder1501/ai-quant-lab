import { DAILY_BAR_FAMILIES, buildZones, dailyBarLevels, type DailyBar, type DailyLevelsInstrument, type Level } from "../domain/levels.js";
import {
  STUDY_PARAMETERS,
  countBy,
  countSession,
  evaluateSession,
  placeboLines,
  summariseReaction,
  type IntradayBar,
  type SessionCounts,
  type StudyFamily,
  type StudyLine,
} from "../domain/reaction-study.js";
import type { StudyPayload } from "../../../infrastructure/database/repositories/postgres-daily-levels-repository.js";

/** A session with fewer 15-minute bars than this is skipped (special short sessions and data gaps); see the protocol. */
export const MINIMUM_SESSION_BARS = 20;

export const STUDY_VERSION = "levels-reaction-v1";

/**
 * Runs the protocol's reaction study over stored sessions: for each session, builds the daily-bar levels from bars strictly before it,
 * adds the placebo lines, finds the first touch of every line and what followed, and summarises real against placebo by family.
 * Pure, so the same bars always give the same numbers.
 */
export function runReactionStudy(
  underlying: DailyLevelsInstrument,
  dailyBars: readonly DailyBar[],
  sessions: ReadonlyMap<string, readonly IntradayBar[]>,
): StudyPayload {
  const families: StudyFamily[] = ["ALL", ...DAILY_BAR_FAMILIES];
  const perFamily = new Map<StudyFamily, SessionCounts[]>(families.map((family) => [family, []]));
  const confluenceSessions: SessionCounts[] = [];
  let sessionsUsed = 0;
  let sessionsSkipped = 0;
  let realLevelTouches = 0;

  for (const date of [...sessions.keys()].sort()) {
    const bars = sessions.get(date) ?? [];
    const base = dailyBarLevels(underlying, date, dailyBars);
    if (bars.length < MINIMUM_SESSION_BARS || base === null) {
      sessionsSkipped += 1;
      continue;
    }
    const confluenceOf = new Map<Level, number>();
    for (const zone of buildZones(base.levels, base.referencePrice)) for (const level of zone.levels) confluenceOf.set(level, zone.confluence);

    const real: StudyLine[] = base.levels.map((level) => ({ key: level.key, family: level.family, kind: "REAL", price: level.price, confluence: confluenceOf.get(level) ?? 1 }));
    const results = evaluateSession(bars, base.referencePrice, [...real, ...placeboLines(real)]);

    for (const family of families) perFamily.get(family)?.push(countSession(results, family));
    confluenceSessions.push(countBy(results, (result) => (result.kind !== "REAL" ? null : (result.confluence ?? 1) >= 2 ? "A" : "B")));
    realLevelTouches += results.filter((result) => result.kind === "REAL").length;
    sessionsUsed += 1;
  }

  return {
    underlying,
    sessionsUsed,
    sessionsSkipped,
    realLevelTouches,
    parameters: { ...STUDY_PARAMETERS, minimumSessionBars: MINIMUM_SESSION_BARS, studyVersion: STUDY_VERSION },
    summaries: families.map((family) => summariseReaction(family, perFamily.get(family) ?? [])),
    confluence: summariseReaction("CONFLUENCE_2_PLUS_VS_1", confluenceSessions),
  };
}
