import { describe, expect, it } from "vitest";
import { HISTORY_CAVEAT, LEVELS_DISCLAIMER, buildDailyLevelsResponse, parseDailyLevelsQuery } from "./daily-levels.routes.js";
import type { StoredLevelSheet, StoredStudy } from "../../../../infrastructure/database/repositories/postgres-daily-levels-repository.js";

const stored: StoredLevelSheet = {
  version: 2,
  generatedAt: "2026-11-03T03:25:00.000Z",
  sheet: {
    underlying: "NIFTY50", sessionDate: "2026-11-03", referenceDate: "2026-10-30", referencePrice: 23_050,
    zones: [], levelCount: 0, unavailable: [{ family: "OI_WALL", reason: "no option-chain observation before the open" }], oi: null,
  },
};

const summary = { family: "ALL", sessions: 945, realResolved: 4758, placeboResolved: 1108, realBounceShare: 0.577, placeboBounceShare: 0.558, difference: 0.019, lower: -0.032, upper: 0.07 };
const study: StoredStudy = {
  studyVersion: "levels-reaction-v1", computedAt: "2026-11-02T13:00:00.000Z", windowFrom: "2023-01-02", windowTo: "2026-10-30",
  payload: {
    underlying: "NIFTY50", sessionsUsed: 945, sessionsSkipped: 3, realLevelTouches: 6444, parameters: {},
    summaries: [summary],
    confluence: { ...summary, family: "CONFLUENCE_2_PLUS_VS_1", difference: -0.03, lower: -0.07, upper: -0.01 },
  },
};

describe("parseDailyLevelsQuery", () => {
  it("accepts an index and an optional date", () => {
    expect(parseDailyLevelsQuery({ underlying: "NIFTY50", date: undefined })).toEqual({ ok: true, value: { underlying: "NIFTY50", date: null } });
    expect(parseDailyLevelsQuery({ underlying: "BANKNIFTY", date: "2026-11-03" })).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: "2026-11-03" } });
  });

  it("refuses an unknown index, a missing index and a malformed date", () => {
    expect(parseDailyLevelsQuery({ underlying: "SBIN", date: undefined }).ok).toBe(false);
    expect(parseDailyLevelsQuery({ underlying: undefined, date: undefined }).ok).toBe(false);
    expect(parseDailyLevelsQuery({ underlying: "NIFTY50", date: "03-11-2026" }).ok).toBe(false);
  });
});

describe("buildDailyLevelsResponse", () => {
  it("says plainly when no sheet exists", () => {
    const body = buildDailyLevelsResponse("NIFTY50", null, study);
    expect(body.available).toBe(false);
    expect(body.disclaimer).toBe(LEVELS_DISCLAIMER);
  });

  it("returns the sheet with its provenance and the history beside it", () => {
    const body = buildDailyLevelsResponse("NIFTY50", stored, study);
    expect(body.available).toBe(true);
    if (!body.available) return;
    expect(body.version).toBe(2);
    expect(body.referencePrice).toBe(23_050);
    expect(body.unavailable[0].family).toBe("OI_WALL");
    expect(body.history?.sessionsUsed).toBe(945);
    expect(body.history?.caveat).toBe(HISTORY_CAVEAT);
  });

  it("writes each comparison's sentence from its interval, and names the group for confluence", () => {
    const body = buildDailyLevelsResponse("NIFTY50", stored, study);
    if (!body.available || body.history === null) throw new Error("expected a sheet with history");
    expect(body.history.comparisons[0].sentence).toBe("No demonstrated difference from random lines (-3.2 to +7.0 points).");
    expect(body.history.confluence?.sentence).toBe("Bounced less often than single-source levels (-7.0 to -1.0 points).");
  });

  it("still returns the sheet when no study has been stored", () => {
    const body = buildDailyLevelsResponse("NIFTY50", stored, null);
    if (!body.available) throw new Error("expected a sheet");
    expect(body.history).toBeNull();
  });
});
