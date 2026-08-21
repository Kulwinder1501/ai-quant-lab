import { describe, expect, it } from "vitest";
import {
  blockPermuted,
  circularShifted,
  signFlipped,
  wrongDayMatchedTime,
} from "./placebos.js";

function sortedMultiset(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

describe("signFlipped", () => {
  it("preserves every magnitude and position count", () => {
    const values = [1, -2, 3, -4, 5, 6, 7, 8];
    const flipped = signFlipped(values, 11);

    expect(flipped).toHaveLength(values.length);
    expect(flipped.map(Math.abs)).toEqual(values.map(Math.abs));
  });

  it("actually flips some signs", () => {
    const values = Array.from({ length: 50 }, (_, index) => index + 1);
    const flipped = signFlipped(values, 11);
    expect(flipped.some((value, index) => value !== values[index])).toBe(true);
  });

  it("is reproducible for a seed", () => {
    const values = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(signFlipped(values, 5)).toEqual(signFlipped(values, 5));
    expect(signFlipped(values, 5)).not.toEqual(signFlipped(values, 6));
  });
});

describe("blockPermuted", () => {
  it("preserves the multiset and length, including a partial trailing block", () => {
    // 10 values in blocks of 3 leaves a trailing block of 1. Dropping it would make the placebo a
    // different length from the real series and their ICs incomparable on sample size.
    const values = Array.from({ length: 10 }, (_, index) => index);
    const permuted = blockPermuted(values, 3, 4);

    expect(permuted).toHaveLength(10);
    expect(sortedMultiset(permuted)).toEqual(sortedMultiset(values));
  });

  it("keeps values adjacent within a block", () => {
    const values = [0, 1, 2, 10, 11, 12, 20, 21, 22];
    const permuted = blockPermuted(values, 3, 8);

    // Whichever order the blocks land in, each run of three must still be a consecutive triple.
    for (let start = 0; start < permuted.length; start += 3) {
      const block = permuted.slice(start, start + 3);
      expect(block[1]! - block[0]!).toBe(1);
      expect(block[2]! - block[1]!).toBe(1);
    }
  });

  it("reorders the blocks", () => {
    const values = Array.from({ length: 60 }, (_, index) => index);
    expect(blockPermuted(values, 5, 3)).not.toEqual(values);
  });

  it("rejects a non-positive block size", () => {
    expect(() => blockPermuted([1, 2, 3], 0, 1)).toThrow(/positive integer/);
    expect(() => blockPermuted([1, 2, 3], 1.5, 1)).toThrow(/positive integer/);
  });

  it("returns empty for empty input", () => {
    expect(blockPermuted([], 3, 1)).toEqual([]);
  });
});

describe("circularShifted", () => {
  it("rotates by the requested offset", () => {
    expect(circularShifted([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5, 1, 2]);
  });

  it("normalises an oversized shift instead of producing holes", () => {
    expect(circularShifted([1, 2, 3], 7)).toEqual([2, 3, 1]);
  });

  it("normalises a negative shift", () => {
    expect(circularShifted([1, 2, 3, 4], -1)).toEqual([4, 1, 2, 3]);
  });

  it("is a no-op for a whole-length shift", () => {
    expect(circularShifted([1, 2, 3, 4], 4)).toEqual([1, 2, 3, 4]);
  });

  it("preserves the multiset", () => {
    const values = Array.from({ length: 40 }, (_, index) => index * 3);
    expect(sortedMultiset(circularShifted(values, 13))).toEqual(sortedMultiset(values));
  });
});

describe("wrongDayMatchedTime", () => {
  /** Same clock time on `days` consecutive sessions, so every bucket spans multiple days. */
  function acrossDays(days: number, valuePerDay: (day: number) => number) {
    const observations: Array<{ at: Date; value: number }> = [];
    for (let day = 0; day < days; day += 1) {
      observations.push({
        // 04:00Z is 09:30 IST, inside the session.
        at: new Date(Date.UTC(2026, 7, 3 + day, 4, 0, 0)),
        value: valuePerDay(day),
      });
    }
    return observations;
  }

  it("permutes values among observations sharing a time-of-day bucket", () => {
    const observations = acrossDays(8, (day) => day * 10);
    const permuted = wrongDayMatchedTime(observations, 21);

    expect(permuted).toHaveLength(8);
    expect(sortedMultiset(permuted)).toEqual(sortedMultiset(observations.map((o) => o.value)));
    expect(permuted).not.toEqual(observations.map((o) => o.value));
  });

  it("leaves a bucket alone when it has only one day to draw from", () => {
    // Nothing to swap with. Inventing a partner would fabricate data rather than shuffle it.
    const observations = [{ at: new Date(Date.UTC(2026, 7, 3, 4, 0, 0)), value: 42 }];
    expect(wrongDayMatchedTime(observations, 1)).toEqual([42]);
  });

  it("does not mix values across different times of day", () => {
    // Two buckets an hour apart, each with its own value range. After permutation the morning
    // observations must still hold morning values -- otherwise the placebo would destroy the
    // time-of-day profile it is meant to preserve.
    const observations: Array<{ at: Date; value: number }> = [];
    for (let day = 0; day < 6; day += 1) {
      observations.push({ at: new Date(Date.UTC(2026, 7, 3 + day, 4, 0, 0)), value: 100 + day });
      observations.push({ at: new Date(Date.UTC(2026, 7, 3 + day, 6, 0, 0)), value: 900 + day });
    }

    const permuted = wrongDayMatchedTime(observations, 33);

    for (let index = 0; index < observations.length; index += 1) {
      const wasMorning = observations[index]!.value < 500;
      expect(permuted[index]! < 500).toBe(wasMorning);
    }
  });

  it("skips observations with an unusable timestamp", () => {
    const observations = [
      { at: new Date("nope"), value: 1 },
      { at: new Date(Date.UTC(2026, 7, 3, 4, 0, 0)), value: 2 },
    ];
    // The invalid row keeps its own value rather than throwing or being dropped from the output,
    // which would misalign the placebo against the return series.
    expect(wrongDayMatchedTime(observations, 1)).toEqual([1, 2]);
  });

  it("rejects a non-positive bucket size", () => {
    expect(() => wrongDayMatchedTime([], 1, 0)).toThrow(/positive integer/);
  });
});
