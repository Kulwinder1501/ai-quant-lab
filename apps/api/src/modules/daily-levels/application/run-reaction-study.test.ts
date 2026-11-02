import { describe, expect, it } from "vitest";
import { MINIMUM_SESSION_BARS, runReactionStudy } from "./run-reaction-study.js";
import type { DailyBar } from "../domain/levels.js";
import type { IntradayBar } from "../domain/reaction-study.js";

const dailyBars: DailyBar[] = [
  { date: "2026-10-26", high: 23_000, low: 22_700, close: 22_900 },
  { date: "2026-10-27", high: 23_050, low: 22_750, close: 22_950 },
  { date: "2026-10-28", high: 23_100, low: 22_800, close: 23_000 },
  { date: "2026-10-29", high: 23_150, low: 22_850, close: 23_050 },
  { date: "2026-10-30", high: 23_200, low: 22_900, close: 23_100 },
];

/** 25 bars drifting gently around the previous close, so a few lines are touched and most outcomes resolve. */
function session(start: number, step: number, count = 25): IntradayBar[] {
  return Array.from({ length: count }, (_, index) => {
    const open = start + index * step;
    const close = open + step;
    return { open, high: Math.max(open, close) + 15, low: Math.min(open, close) - 15, close };
  });
}

describe("runReactionStudy", () => {
  const sessions = new Map<string, IntradayBar[]>([
    ["2026-11-02", session(23_100, 8)],
    ["2026-11-03", session(23_300, -9)],
    ["2026-11-04", session(23_100, 3, MINIMUM_SESSION_BARS - 1)], // too short: skipped
  ]);

  it("uses sessions with enough bars and counts the short ones as skipped", () => {
    const result = runReactionStudy("NIFTY50", dailyBars, sessions);
    expect(result.sessionsUsed).toBe(2);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.realLevelTouches).toBeGreaterThan(0);
  });

  it("summarises ALL and every daily-bar family, plus the confluence comparison", () => {
    const result = runReactionStudy("NIFTY50", dailyBars, sessions);
    expect(result.summaries.map((summary) => summary.family)).toEqual(["ALL", "PRIOR_DAY", "PIVOT", "RANGE_5D", "RANGE_WEEK", "ROUND_NUMBER"]);
    expect(result.confluence?.family).toBe("CONFLUENCE_2_PLUS_VS_1");
    expect(result.summaries[0].sessions).toBe(2);
  });

  it("gives identical numbers for identical input, whatever order the sessions arrive in", () => {
    const reversed = new Map([...sessions.entries()].reverse());
    expect(runReactionStudy("NIFTY50", dailyBars, reversed)).toEqual(runReactionStudy("NIFTY50", dailyBars, sessions));
  });

  it("skips a session that has no daily bar before it", () => {
    const early = new Map([["2026-10-20", session(22_900, 5)]]);
    const result = runReactionStudy("NIFTY50", dailyBars, early);
    expect(result.sessionsUsed).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
  });

  it("never uses the session's own daily bar to build its levels", () => {
    const withSelf = [...dailyBars, { date: "2026-11-02", high: 99_999, low: 1, close: 50_000 }];
    const result = runReactionStudy("NIFTY50", withSelf, new Map([["2026-11-02", session(23_100, 8)]]));
    const without = runReactionStudy("NIFTY50", dailyBars, new Map([["2026-11-02", session(23_100, 8)]]));
    expect(result).toEqual(without);
  });
});
