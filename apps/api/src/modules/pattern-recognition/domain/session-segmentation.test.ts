import { describe, expect, it } from "vitest";
import type { PatternCandle } from "./market-pattern.js";
import {
  findSuppressedCandleIds,
  isIntradayTimeframe,
  istSessionDate,
  splitIntoSessions,
  timeframeMinutes,
} from "./session-segmentation.js";

function bar(id: string, openTimeIso: string, overrides: Partial<PatternCandle> = {}): PatternCandle {
  return {
    id,
    openTime: new Date(openTimeIso),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    ...overrides,
  };
}

describe("timeframe classification", () => {
  it("parses minute, hour and day labels", () => {
    expect(timeframeMinutes("5m")).toBe(5);
    expect(timeframeMinutes("1h")).toBe(60);
    expect(timeframeMinutes("1d")).toBe(1440);
    expect(timeframeMinutes("weekly")).toBeNull();
  });

  it("treats only sub-day bars as intraday, and an unknown label as not intraday", () => {
    expect(isIntradayTimeframe("1m")).toBe(true);
    expect(isIntradayTimeframe("15m")).toBe(true);
    expect(isIntradayTimeframe("4h")).toBe(true);
    expect(isIntradayTimeframe("1440m")).toBe(false);
    expect(isIntradayTimeframe("1d")).toBe(false);
    expect(isIntradayTimeframe("weekly")).toBe(false);
  });
});

describe("istSessionDate", () => {
  it("keys a bar by its IST calendar date, not its UTC date", () => {
    // 09:15 IST = 03:45 UTC (same date); 00:30 IST on the 11th = 19:00 UTC on the 10th.
    expect(istSessionDate(new Date("2026-08-10T03:45:00Z"))).toBe("2026-08-10");
    expect(istSessionDate(new Date("2026-08-10T19:00:00Z"))).toBe("2026-08-11");
  });
});

describe("splitIntoSessions", () => {
  it("cuts an intraday series at the IST date so day two cannot see day one", () => {
    const candles = [
      bar("a1", "2026-08-10T09:50:00Z"), // 15:20 IST on the 10th
      bar("a2", "2026-08-10T09:55:00Z"), // 15:25 IST on the 10th
      bar("b1", "2026-08-11T03:45:00Z"), // 09:15 IST on the 11th
      bar("b2", "2026-08-11T03:50:00Z"),
    ];
    const sessions = splitIntoSessions(candles, "5m");
    expect(sessions.map((session) => session.map((c) => c.id))).toEqual([["a1", "a2"], ["b1", "b2"]]);
  });

  it("keeps a daily series as one segment, preserving order", () => {
    const candles = [
      bar("d1", "2026-08-10T00:00:00Z"),
      bar("d2", "2026-08-11T00:00:00Z"),
      bar("d3", "2026-08-12T00:00:00Z"),
    ];
    const sessions = splitIntoSessions(candles, "1d");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.map((c) => c.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("returns no segments for an empty series", () => {
    expect(splitIntoSessions([], "5m")).toEqual([]);
  });
});

describe("findSuppressedCandleIds", () => {
  it("suppresses a flat zero-volume bar", () => {
    const segment = [
      bar("ok", "2026-08-10T04:00:00Z"),
      bar("flat", "2026-08-10T04:05:00Z", { open: 100, high: 100, low: 100, close: 100, volume: 0 }),
    ];
    expect([...findSuppressedCandleIds(segment)]).toEqual(["flat"]);
  });

  it("suppresses a zero-volume bar inside a segment that otherwise reports volume", () => {
    const segment = [
      bar("ok", "2026-08-10T04:00:00Z"),
      bar("stale", "2026-08-10T04:05:00Z", { volume: 0 }), // has a range, but no trades
    ];
    expect([...findSuppressedCandleIds(segment)]).toEqual(["stale"]);
  });

  it("does not silence a feed that never reports volume (FX, DXY, INDIAVIX)", () => {
    const segment = [
      bar("fx1", "2026-08-10T04:00:00Z", { volume: 0 }),
      bar("fx2", "2026-08-10T04:05:00Z", { volume: 0, high: 102 }),
    ];
    expect(findSuppressedCandleIds(segment).size).toBe(0);
  });

  it("keeps a flat bar that did trade", () => {
    const segment = [bar("pinned", "2026-08-10T04:00:00Z", { high: 100, low: 100, open: 100, close: 100, volume: 50 })];
    expect(findSuppressedCandleIds(segment).size).toBe(0);
  });
});
