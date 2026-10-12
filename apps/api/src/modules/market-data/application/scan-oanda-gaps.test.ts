import { describe, expect, it } from "vitest";
import {
  chunkMissingRange,
  findMissingSessionRanges,
  isHealSessionActive,
  scanOandaGaps,
} from "./scan-oanda-gaps.js";

const isSessionActive = isHealSessionActive;

// October 2026 is US daylight time (UTC-4): the daily break is 21:00-22:00 UTC Mon-Thu, the
// weekend closes Friday 21:00 UTC and reopens Sunday 22:00 UTC.
function minutes(startIso: string, count: number): Date[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => new Date(start + i * 60_000));
}

describe("findMissingSessionRanges", () => {
  it("reports a hole in the middle of an open session", () => {
    const openTimes = [
      ...minutes("2026-10-08T12:00:00Z", 60),
      ...minutes("2026-10-08T16:00:00Z", 30),
    ];
    const ranges = findMissingSessionRanges({
      openTimes,
      scanTo: new Date("2026-10-08T16:30:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.from.toISOString()).toBe("2026-10-08T13:00:00.000Z");
    expect(ranges[0]!.to.toISOString()).toBe("2026-10-08T15:59:00.000Z");
    expect(ranges[0]!.minutes).toBe(180);
  });

  it("does not call the daily 17:00-18:00 New York break a gap", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-08T20:59:00Z"), new Date("2026-10-08T22:00:00Z")],
      scanTo: new Date("2026-10-08T22:01:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges).toEqual([]);
  });

  it("does not call the weekend close a gap", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-09T20:59:00Z"), new Date("2026-10-11T22:00:00Z")],
      scanTo: new Date("2026-10-11T22:01:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges).toEqual([]);
  });

  it("reports the stretch between the last stored bar and the scan end when the session was open", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-09T15:14:00Z")],
      scanTo: new Date("2026-10-09T23:00:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.from.toISOString()).toBe("2026-10-09T15:15:00.000Z");
    expect(ranges[0]!.to.toISOString()).toBe("2026-10-09T20:59:00.000Z");
    expect(ranges[0]!.minutes).toBe(345);
  });

  it("splits a hole that straddles the daily break into two session-only ranges", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-08T20:29:00Z"), new Date("2026-10-08T22:30:00Z")],
      scanTo: new Date("2026-10-08T22:31:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges.map((r) => [r.from.toISOString(), r.to.toISOString(), r.minutes])).toEqual([
      ["2026-10-08T20:30:00.000Z", "2026-10-08T20:59:00.000Z", 30],
      ["2026-10-08T22:00:00.000Z", "2026-10-08T22:29:00.000Z", 30],
    ]);
  });

  it("ignores holes shorter than the minimum", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-08T13:00:00Z"), new Date("2026-10-08T13:04:00Z")],
      scanTo: new Date("2026-10-08T13:05:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    });
    expect(ranges).toEqual([]);
  });

  it("never calls the live edge missing", () => {
    const ranges = findMissingSessionRanges({
      openTimes: [new Date("2026-10-08T13:00:00Z")],
      scanTo: new Date("2026-10-08T13:20:00Z"),
      isSessionActive,
      minMissingMinutes: 30,
    });
    expect(ranges).toEqual([]);
  });

  it("returns nothing when there are no stored bars to anchor a gap on", () => {
    expect(findMissingSessionRanges({
      openTimes: [],
      scanTo: new Date("2026-10-08T13:20:00Z"),
      isSessionActive,
      minMissingMinutes: 5,
    })).toEqual([]);
  });
});

describe("chunkMissingRange", () => {
  it("splits a long range into contiguous chunks no larger than the cap", () => {
    const range = {
      from: new Date("2026-10-05T00:00:00Z"),
      to: new Date(new Date("2026-10-05T00:00:00Z").getTime() + (10_000 - 1) * 60_000),
      minutes: 10_000,
    };
    const chunks = chunkMissingRange(range, 4_000);
    expect(chunks.map((c) => c.minutes)).toEqual([4_000, 4_000, 2_000]);
    expect(chunks[0]!.from).toEqual(range.from);
    expect(chunks[2]!.to).toEqual(range.to);
    expect(chunks[1]!.from.getTime()).toBe(chunks[0]!.to.getTime() + 60_000);
  });

  it("returns a single chunk for a short range", () => {
    const range = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-05T00:09:00Z"), minutes: 10 };
    expect(chunkMissingRange(range, 4_000)).toEqual([range]);
  });
});

describe("scanOandaGaps", () => {
  async function scan(symbol: string) {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const database = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ open_time: new Date("2026-10-09T15:14:00Z") }] };
      },
    };
    const ranges = await scanOandaGaps(database as never, {
      symbol,
      lookbackDays: 7,
      minMissingMinutes: 5,
      tailGraceMinutes: 30,
      now: new Date("2026-10-09T21:30:00Z"),
    });
    return { ranges, capturedSql, capturedParams };
  }

  it("reads only the named OANDA symbol's 1m bars and applies the tail grace", async () => {
    const { ranges, capturedSql, capturedParams } = await scan("XAU_USD");
    expect(capturedSql).toContain("i.exchange = 'OANDA'");
    expect(capturedSql).toContain("i.symbol = $2");
    expect(capturedSql).toContain("c.timeframe = '1m'");
    expect((capturedParams[0] as Date).toISOString()).toBe("2026-10-02T21:30:00.000Z");
    expect(capturedParams[1]).toBe("XAU_USD");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.to.toISOString()).toBe("2026-10-09T20:59:00.000Z");
  });

  it("scans an FX pair or the synthetic DXY series by symbol, with the same session calendar", async () => {
    for (const symbol of ["EUR_USD", "DXY"]) {
      const { ranges, capturedParams } = await scan(symbol);
      expect(capturedParams[1]).toBe(symbol);
      expect(ranges[0]!.to.toISOString()).toBe("2026-10-09T20:59:00.000Z");
    }
  });
});
