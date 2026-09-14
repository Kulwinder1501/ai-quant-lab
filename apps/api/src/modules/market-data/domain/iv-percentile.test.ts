import { describe, expect, it } from "vitest";
import {
  MINIMUM_DISTINCT_DAYS,
  summariseIvPercentile,
  type DailyImpliedVolatility,
} from "./iv-percentile.js";

/** `days` distinct days rising from 0.10, so the rank of any reading is easy to reason about. */
function history(days: number, start = 0.10, step = 0.002): DailyImpliedVolatility[] {
  return Array.from({ length: days }, (_unused, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    impliedVolatility: start + index * step,
  }));
}

describe("summariseIvPercentile", () => {
  it("ranks a reading against its own daily history", () => {
    // 20 days from 0.100 to 0.138. A reading of 0.121 sits above the first 11.
    const result = summariseIvPercentile({
      history: history(20), currentImpliedVolatility: 0.121,
    });

    expect(result.measurable).toBe(true);
    if (result.measurable) {
      expect(result.percentile).toBeCloseTo(55, 5);
      expect(result.observedDays).toBe(20);
      expect(result.lowestImpliedVolatility).toBeCloseTo(0.100, 6);
      expect(result.highestImpliedVolatility).toBeCloseTo(0.138, 6);
    }
  });

  it("puts a new high at 100 and a new low at 0", () => {
    expect(summariseIvPercentile({ history: history(20), currentImpliedVolatility: 0.9 }))
      .toMatchObject({ measurable: true, percentile: 100 });
    expect(summariseIvPercentile({ history: history(20), currentImpliedVolatility: 0.01 }))
      .toMatchObject({ measurable: true, percentile: 0 });
  });

  it("counts only days strictly below, so a flat series does not read as a new high", () => {
    // Every stored day is 0.12 and today is 0.12. "Never been higher" needs a day it exceeded.
    const flat = Array.from({ length: 25 }, (_unused, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`, impliedVolatility: 0.12,
    }));

    expect(summariseIvPercentile({ history: flat, currentImpliedVolatility: 0.12 }))
      .toMatchObject({ measurable: true, percentile: 0 });
  });

  // The reason this is day-based at all: 15-minute snapshots are autocorrelated, so raw
  // observations would let two sessions masquerade as fifty independent samples and report a
  // confident percentile from nothing.
  it("collapses repeated readings for one day to a single value", () => {
    const sameDay: DailyImpliedVolatility[] = Array.from({ length: 300 }, () => ({
      date: "2026-08-04", impliedVolatility: 0.11,
    }));

    const result = summariseIvPercentile({ history: sameDay, currentImpliedVolatility: 0.2 });

    expect(result.measurable).toBe(false);
    if (!result.measurable) {
      expect(result.observedDays).toBe(1);
      expect(result.reason).toBe("INSUFFICIENT_HISTORY");
    }
  });

  it("refuses a short history rather than computing a meaningless percentile", () => {
    // The live state on 2026-08-05: two days of chain snapshots.
    const result = summariseIvPercentile({ history: history(2), currentImpliedVolatility: 0.13 });

    expect(result.measurable).toBe(false);
    if (!result.measurable) {
      expect(result.reason).toBe("INSUFFICIENT_HISTORY");
      expect(result.requiredDays).toBe(MINIMUM_DISTINCT_DAYS);
      expect(result.explanation).toMatch(/cannot be backfilled/);
    }
  });

  it("refuses when the current chain yielded no IV", () => {
    const result = summariseIvPercentile({
      history: history(30), currentImpliedVolatility: null,
    });

    expect(result.measurable).toBe(false);
    if (!result.measurable) expect(result.reason).toBe("NO_CURRENT_READING");
  });

  it("ignores non-positive stored readings instead of ranking against them", () => {
    const dirty = [...history(20), { date: "2026-06-21", impliedVolatility: 0 }];

    const result = summariseIvPercentile({ history: dirty, currentImpliedVolatility: 0.121 });

    expect(result.measurable).toBe(true);
    if (result.measurable) expect(result.observedDays).toBe(20);
  });

  it("honours a caller-supplied minimum", () => {
    expect(summariseIvPercentile({
      history: history(5), currentImpliedVolatility: 0.11, minimumDays: 5,
    }).measurable).toBe(true);
  });
});
