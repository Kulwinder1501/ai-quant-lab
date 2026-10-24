import { describe, expect, it } from "vitest";
import {
  bucketSessionVolume,
  compareWithBaseline,
  completeSessionTotal,
  median,
  type VolumeBucket,
} from "./volume-by-time.js";
import type { FuturesBar } from "./session-volume-profile.js";

/** 2026-10-22; 09:15 IST = 03:45Z. Bars are synthetic, hand-built for the arithmetic (not recorded). */
const OPEN = Date.parse("2026-10-22T03:45:00.000Z");
const bar = (minute: number, volume: number): FuturesBar => ({
  openTime: new Date(OPEN + minute * 60_000), open: 100, high: 101, low: 99, close: 100, volume,
});
/** One bar per minute from `from` up to (not including) `to`, each carrying `volume`. */
const minutes = (from: number, to: number, volume: number): FuturesBar[] => Array.from({ length: to - from }, (_, i) => bar(from + i, volume));

/** A bucket of `length` minutes starting at `from` holding `volume` in total: all of it on the first minute, the rest present but traded nothing. */
const bucketOf = (from: number, length: number, volume: number): FuturesBar[] =>
  Array.from({ length }, (_, i) => bar(from + i, i === 0 ? volume : 0));

/**
 * A 30-minute-bucket day with the given volume for each of the first 12 buckets and `tail` for the 13th, which is only the
 * last 15 minutes of the session; every minute present.
 */
function day(perBucket: number[], tail = 0): VolumeBucket[] {
  return bucketSessionVolume([
    ...perBucket.flatMap((volume, index) => bucketOf(index * 30, 30, volume)),
    ...bucketOf(360, 15, tail),
  ], 30);
}

describe("bucketSessionVolume", () => {
  it("sums the reported volume of the bars in each clock bucket, from 09:15", () => {
    const buckets = bucketSessionVolume([...minutes(0, 15, 10), ...minutes(15, 30, 20)], 15);
    expect(buckets).toHaveLength(25);
    expect(buckets[0]).toMatchObject({ startMinute: 555, endMinute: 570, volume: 150, barsPresent: 15, expectedBars: 15, complete: true });
    expect(buckets[1]).toMatchObject({ startMinute: 570, endMinute: 585, volume: 300, complete: true });
  });

  it("covers the 375-minute session for each bucket size, with a shorter last bucket when it does not divide", () => {
    expect(bucketSessionVolume([], 5)).toHaveLength(75);
    expect(bucketSessionVolume([], 15)).toHaveLength(25);
    const half = bucketSessionVolume([], 30);
    expect(half).toHaveLength(13);
    expect(half[11]).toMatchObject({ startMinute: 885, endMinute: 915, expectedBars: 30 });
    expect(half[12]).toMatchObject({ startMinute: 915, endMinute: 930, expectedBars: 15 });
    // That last bucket is complete with its 15 minutes, not incomplete for lacking 30.
    expect(bucketSessionVolume(minutes(360, 375, 1), 30)[12]).toMatchObject({ barsPresent: 15, complete: true, volume: 15 });
  });

  it("calls a bucket with no bar unknown, not zero, and one with a zero-volume bar a real zero", () => {
    const buckets = bucketSessionVolume([bar(0, 0), bar(1, 0), bar(2, 0), bar(3, 0), bar(4, 0)], 5);
    expect(buckets[0]).toMatchObject({ volume: 0, complete: true, barsPresent: 5 });
    expect(buckets[1]).toMatchObject({ volume: null, complete: false, barsPresent: 0 });
  });

  it("marks a bucket missing a minute incomplete, with the volume of the minutes it has", () => {
    const buckets = bucketSessionVolume([bar(0, 10), bar(1, 10), bar(3, 10), bar(4, 10)], 5);
    expect(buckets[0]).toMatchObject({ volume: 40, barsPresent: 4, complete: false });
  });

  it("counts a repeated minute once, so a duplicated row cannot inflate a bucket or hide a hole", () => {
    const buckets = bucketSessionVolume([bar(0, 10), bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10)], 5);
    expect(buckets[0]).toMatchObject({ volume: 40, barsPresent: 4, complete: false });
  });

  it("ignores bars outside the session and refuses a bucket size that is not a positive whole number", () => {
    expect(bucketSessionVolume([bar(-1, 999), bar(375, 999)], 15).every((b) => b.volume === null)).toBe(true);
    for (const bad of [0, -5, 2.5, Number.NaN]) expect(() => bucketSessionVolume([], bad), String(bad)).toThrow("positive whole number");
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the two middle values, and null when empty", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("compareWithBaseline", () => {
  // Baseline of three sessions over 12 half-hour buckets.
  const sessions = [
    day([300, 200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 200]),
    day([500, 300, 100, 100, 100, 100, 100, 100, 100, 100, 100, 200]),
    day([400, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 400]),
  ];

  it("takes the median of each bucket over the baseline sessions, with the mean and the count", () => {
    const today = day([800, 150, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const result = compareWithBaseline(today, sessions);
    expect(result[0]).toMatchObject({ baselineMedian: 400, baselineSessions: 3, relative: 2 });
    expect(result[0]!.baselineMean).toBeCloseTo(400, 10);
    expect(result[1]).toMatchObject({ baselineMedian: 200, relative: 0.75 });
    expect(result[11]).toMatchObject({ baselineMedian: 200, relative: 0.5 });
    // The median ignores one heavy session where the mean does not.
    const skewed = compareWithBaseline(today, [...sessions, day([4000, 200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 200])]);
    expect(skewed[0]!.baselineMedian).toBe(450);
    expect(skewed[0]!.baselineMean).toBeCloseTo(1300, 10);
  });

  it("compares the cumulative volume with the median cumulative volume at the same time", () => {
    const today = day([800, 150, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const result = compareWithBaseline(today, sessions);
    // Cumulative of the baseline sessions after bucket 1: 500, 800, 500 -> median 500. Today: 950.
    expect(result[1]).toMatchObject({ cumulative: 950, baselineCumulativeMedian: 500, baselineCumulativeSessions: 3, cumulativeRelative: 1.9 });
    expect(result[11]!.cumulative).toBe(1950);   // 800 + 150 + ten buckets of 100
  });

  it("leaves an incomplete bucket out of its baseline, and says how many sessions the figure stands on", () => {
    const holed = bucketSessionVolume([...minutes(0, 30, 10), ...minutes(31, 60, 10)], 30); // bucket 1 misses minute 30
    const partial = sessions.map((s) => s.map((b) => ({ ...b })));
    partial[0]![1] = holed[1]!;
    const result = compareWithBaseline(day([800, 150, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), partial);
    expect(result[1]).toMatchObject({ baselineSessions: 2, baselineMedian: 200 });   // 300 and 100 -> 200; the holed session is out
    // The holed session drops out of the cumulative baseline from that bucket on.
    expect(result[1]!.baselineCumulativeSessions).toBe(2);
    expect(result[5]!.baselineCumulativeSessions).toBe(2);
    expect(result[0]!.baselineCumulativeSessions).toBe(3);
  });

  it("gives no ratio for an incomplete bucket of today, nor cumulative volume from there on", () => {
    const todayBuckets = bucketSessionVolume([...minutes(0, 30, 10), ...minutes(30, 45, 10)], 30);   // bucket 1 only half there
    const result = compareWithBaseline(todayBuckets, sessions);
    expect(result[0]).toMatchObject({ complete: true, relative: 300 / 400, cumulative: 300 });
    expect(result[1]).toMatchObject({ complete: false, volume: 150, relative: null, cumulative: null, cumulativeRelative: null });
    expect(result[2]).toMatchObject({ volume: null, relative: null, cumulative: null });
    // The unknown tail has a baseline to compare against but nothing to compare.
    expect(result[2]!.baselineMedian).toBe(100);
  });

  it("gives no ratio against a baseline of zero or no baseline at all", () => {
    const quiet = [day(new Array<number>(12).fill(0))];
    expect(compareWithBaseline(day(new Array<number>(12).fill(100)), quiet)[0]).toMatchObject({ baselineMedian: 0, relative: null });
    expect(compareWithBaseline(day(new Array<number>(12).fill(100)), [])[0]).toMatchObject({ baselineMedian: null, baselineSessions: 0, relative: null, cumulativeRelative: null });
  });
});

describe("completeSessionTotal", () => {
  it("is the total of a session with every bucket complete, and null when any bucket has a hole", () => {
    expect(completeSessionTotal(day([300, 200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 200]))).toBe(1600);
    expect(completeSessionTotal(bucketSessionVolume(minutes(0, 20, 10), 30))).toBeNull();
    expect(completeSessionTotal([])).toBeNull();
  });
});
