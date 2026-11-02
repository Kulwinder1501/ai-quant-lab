import { describe, expect, it } from "vitest";
import {
  buildLevelSheet,
  buildZones,
  dailyBarLevels,
  isoWeekKey,
  oiWallLevels,
  pivotLevels,
  priorDayLevels,
  rangeLevels,
  roundNumberLevels,
  weekLevels,
  type DailyBar,
  type Level,
} from "./levels.js";

const bar = (date: string, high: number, low: number, close: number): DailyBar => ({ date, high, low, close });
const priceOf = (levels: readonly Level[], key: string): number | undefined => levels.find((level) => level.key === key)?.price;

describe("classic levels from the previous day", () => {
  const previous = bar("2026-10-30", 100, 80, 90);

  it("gives the previous high, low and close", () => {
    const levels = priorDayLevels(previous);
    expect(priceOf(levels, "pdh")).toBe(100);
    expect(priceOf(levels, "pdl")).toBe(80);
    expect(priceOf(levels, "pdc")).toBe(90);
  });

  it("gives the floor-trader pivots (hand-computed: P 90, R1 100, S1 80, R2 110, S2 70, R3 120, S3 60)", () => {
    const levels = pivotLevels(previous);
    expect(priceOf(levels, "pivot")).toBe(90);
    expect(priceOf(levels, "r1")).toBe(100);
    expect(priceOf(levels, "s1")).toBe(80);
    expect(priceOf(levels, "r2")).toBe(110);
    expect(priceOf(levels, "s2")).toBe(70);
    expect(priceOf(levels, "r3")).toBe(120);
    expect(priceOf(levels, "s3")).toBe(60);
  });
});

describe("multi-day ranges", () => {
  it("uses the last five sessions and needs at least two", () => {
    expect(rangeLevels([bar("2026-10-30", 5, 1, 3)])).toEqual([]);
    const sessions = [
      bar("2026-10-20", 500, 1, 3), // older than five sessions: ignored
      bar("2026-10-23", 10, 8, 9),
      bar("2026-10-26", 12, 7, 9),
      bar("2026-10-27", 11, 6, 9),
      bar("2026-10-28", 13, 8, 9),
      bar("2026-10-29", 12, 9, 9),
    ];
    const levels = rangeLevels(sessions);
    expect(priceOf(levels, "range-high")).toBe(13);
    expect(priceOf(levels, "range-low")).toBe(6);
  });

  it("names the ISO week of a date, including the year boundary", () => {
    expect(isoWeekKey("2026-11-02")).toBe("2026-W45");
    expect(isoWeekKey("2026-10-30")).toBe("2026-W44");
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
  });

  it("takes the whole previous week, never the current one", () => {
    const bars = [
      bar("2026-10-23", 999, 1, 5), // two weeks back
      bar("2026-10-26", 110, 100, 105),
      bar("2026-10-30", 120, 95, 100),
      bar("2026-11-02", 500, 2, 50), // the current week
    ];
    const levels = weekLevels(bars, "2026-11-03");
    expect(priceOf(levels, "week-high")).toBe(120);
    expect(priceOf(levels, "week-low")).toBe(95);
  });

  it("gives nothing when the previous week has no stored bar", () => {
    expect(weekLevels([bar("2026-10-12", 10, 5, 7)], "2026-11-03")).toEqual([]);
  });
});

describe("round numbers", () => {
  it("gives the two multiples below and the two above", () => {
    expect(roundNumberLevels(25_130, 100).map((level) => level.price)).toEqual([25_000, 25_100, 25_200, 25_300]);
  });

  it("includes a multiple that sits exactly on the price", () => {
    expect(roundNumberLevels(25_100, 100).map((level) => level.price)).toEqual([25_000, 25_100, 25_200, 25_300]);
  });
});

describe("open interest walls", () => {
  const strikes = [
    { strike: 25_000, callOi: 5_000_000, putOi: 9_000_000 },
    { strike: 25_100, callOi: 1_000_000, putOi: 12_000_000 },
    { strike: 25_300, callOi: 14_000_000, putOi: 1_000_000 },
    { strike: 25_400, callOi: 8_000_000, putOi: 0 },
  ];

  it("picks the heaviest call strike above the price and the heaviest put strike below it", () => {
    const walls = oiWallLevels(strikes, 25_200);
    expect(priceOf(walls, "call-oi-wall")).toBe(25_300);
    expect(priceOf(walls, "put-oi-wall")).toBe(25_100);
    expect(walls.find((wall) => wall.key === "call-oi-wall")?.note).toBe("call OI 140.0L");
  });

  it("breaks a tie toward the strike nearer the price and ignores strikes with no open interest", () => {
    const tied = [
      { strike: 25_300, callOi: 7, putOi: 0 },
      { strike: 25_500, callOi: 7, putOi: 0 },
      { strike: 25_100, callOi: 0, putOi: 0 },
    ];
    const walls = oiWallLevels(tied, 25_200);
    expect(priceOf(walls, "call-oi-wall")).toBe(25_300);
    expect(priceOf(walls, "put-oi-wall")).toBeUndefined();
  });
});

describe("zones", () => {
  const lines = (specs: Array<[Level["family"], string, number]>): Level[] => specs.map(([family, key, price]) => ({ family, key, label: key, price }));

  it("groups lines within 0.10% of the first line of a group, without chaining", () => {
    // Reference 100, tolerance 0.1: 100 and 100.08 share a zone; 100.16 is more than 0.1 from 100 and starts a new one.
    const zones = buildZones(lines([["PIVOT", "a", 100], ["PRIOR_DAY", "b", 100.08], ["RANGE_5D", "c", 100.16]]), 100);
    expect(zones).toHaveLength(2);
    expect(zones[0].levels.map((level) => level.key)).toEqual(["a", "b"]);
    expect(zones[1].levels.map((level) => level.key)).toEqual(["c"]);
  });

  it("counts distinct families as the confluence, not the number of lines", () => {
    const zones = buildZones(lines([["PIVOT", "r1", 100], ["PIVOT", "r2", 100.05], ["PRIOR_DAY", "pdh", 100.02]]), 100);
    expect(zones).toHaveLength(1);
    expect(zones[0].levels).toHaveLength(3);
    expect(zones[0].confluence).toBe(2);
    expect(zones[0].families).toEqual(["PIVOT", "PRIOR_DAY"]);
  });

  it("places a zone above, below or at the reference price, with its distance", () => {
    const zones = buildZones(lines([["PIVOT", "low", 90], ["PIVOT", "mid", 100], ["PIVOT", "high", 110]]), 100);
    expect(zones.map((zone) => zone.position)).toEqual(["BELOW", "AT", "ABOVE"]);
    expect(zones[0].distancePoints).toBe(-10);
    expect(zones[0].distancePct).toBe(-10);
    expect(zones[2].distancePoints).toBe(10);
  });

  it("drops non-finite and non-positive prices", () => {
    expect(buildZones(lines([["PIVOT", "nan", Number.NaN], ["PIVOT", "neg", -5], ["PIVOT", "ok", 100]]), 100)).toHaveLength(1);
  });
});

describe("the sheet", () => {
  const bars = [
    bar("2026-10-26", 25_300, 25_000, 25_200),
    bar("2026-10-29", 25_400, 25_100, 25_250),
    bar("2026-10-30", 25_500, 25_200, 25_450),
    bar("2026-11-03", 99_999, 1, 50_000), // the session itself: must never be used
  ];

  it("is built from bars strictly before the session", () => {
    const sheet = buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: bars, oiStrikes: null });
    expect(sheet?.referenceDate).toBe("2026-10-30");
    expect(sheet?.referencePrice).toBe(25_450);
    const prices = sheet?.zones.flatMap((zone) => zone.levels.map((level) => level.price)) ?? [];
    expect(Math.max(...prices)).toBeLessThan(30_000);
    expect(Math.min(...prices)).toBeGreaterThan(20_000);
  });

  it("is the same for the same inputs in any bar order", () => {
    const a = buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: bars, oiStrikes: null });
    const b = buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: [...bars].reverse(), oiStrikes: null });
    expect(b).toEqual(a);
  });

  it("says which sources are missing instead of hiding them", () => {
    const sheet = buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: bars, oiStrikes: null });
    expect(sheet?.unavailable.map((item) => item.family)).toContain("OI_WALL");
    expect(sheet?.oi).toBeNull();
  });

  it("adds the open interest walls and records when and for which expiry they were observed", () => {
    const sheet = buildLevelSheet({
      underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: bars,
      oiStrikes: [{ strike: 25_600, callOi: 9_000_000, putOi: 100 }, { strike: 25_300, callOi: 100, putOi: 8_000_000 }],
      oiObservedAt: "2026-10-30T09:59:00.000Z", oiExpiry: "2026-11-03",
    });
    const all = sheet?.zones.flatMap((zone) => zone.levels) ?? [];
    expect(priceOf(all, "call-oi-wall")).toBe(25_600);
    expect(priceOf(all, "put-oi-wall")).toBe(25_300);
    expect(sheet?.oi).toEqual({ observedAt: "2026-10-30T09:59:00.000Z", expiry: "2026-11-03" });
    expect(sheet?.unavailable.map((item) => item.family)).not.toContain("OI_WALL");
  });

  it("is null when there is no completed bar before the session", () => {
    expect(buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-10-26", dailyBars: bars.slice(0, 1), oiStrikes: null })).toBeNull();
  });

  it("uses the same daily-bar construction the reaction study replays", () => {
    const study = dailyBarLevels("NIFTY50", "2026-11-03", bars);
    const sheet = buildLevelSheet({ underlying: "NIFTY50", sessionDate: "2026-11-03", dailyBars: bars, oiStrikes: null });
    const shown = (sheet?.zones.flatMap((zone) => zone.levels) ?? []).map((level) => level.key).sort();
    expect(shown).toEqual(study?.levels.map((level) => level.key).sort());
  });
});
