import { describe, expect, it } from "vitest";
import {
  averagedRanks,
  createSeededRandom,
  informationCoefficient,
  pearson,
  spearman,
} from "./information-coefficient.js";

describe("averagedRanks", () => {
  it("ranks distinct values 1-based in input order", () => {
    expect(averagedRanks([10, 30, 20])).toEqual([1, 3, 2]);
  });

  it("averages ranks across a tied block", () => {
    // Positions 2 and 3 are tied, so both take rank 2.5 rather than an arbitrary 2 and 3.
    expect(averagedRanks([1, 5, 5, 9])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("gives a fully constant series one shared rank", () => {
    // This is what stops a quiet book -- many identical imbalance values -- from contributing a
    // spurious ordering derived from arrival time.
    expect(averagedRanks([7, 7, 7, 7])).toEqual([2.5, 2.5, 2.5, 2.5]);
  });
});

describe("spearman and pearson", () => {
  it("returns 1 for a perfectly increasing relationship", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfectly decreasing relationship", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it("returns null rather than zero when a series is constant", () => {
    // The distinction the whole file rests on: null means nothing was measurable, 0 would assert a
    // measured absence of relationship. A broken feature pipeline must not read as a clean negative.
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
    expect(pearson([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
  });

  it("returns null on mismatched or degenerate input", () => {
    expect(spearman([1, 2, 3], [1, 2])).toBeNull();
    expect(spearman([1], [1])).toBeNull();
  });

  it("scores a monotonic but non-linear relationship as 1 where pearson does not", () => {
    const feature = [1, 2, 3, 4, 5, 6];
    const exponential = feature.map((value) => Math.exp(value));

    expect(spearman(feature, exponential)).toBeCloseTo(1, 10);
    expect(pearson(feature, exponential)!).toBeLessThan(0.95);
  });

  it("resists a single outlier that dominates pearson", () => {
    // The heavy-tail case this module was chosen for: one absurd observation during a liquidity
    // vacuum. Spearman stays near zero; pearson is dragged toward the outlier.
    const feature = [1, 2, 3, 4, 5, 6, 7, 1_000_000];
    const forward = [3, 1, 4, 1, 5, 9, 2, 1_000_000];

    expect(Math.abs(spearman(feature, forward)!)).toBeLessThan(0.7);
    expect(pearson(feature, forward)!).toBeGreaterThan(0.99);
  });

  it("ignores non-finite pairs instead of poisoning the result", () => {
    expect(spearman([1, 2, Number.NaN, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });
});

describe("createSeededRandom", () => {
  it("is reproducible for a given seed and differs across seeds", () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    const other = createSeededRandom(43);

    const drawsFirst = [first(), first(), first()];
    const drawsSecond = [second(), second(), second()];
    const drawsOther = [other(), other(), other()];

    expect(drawsFirst).toEqual(drawsSecond);
    expect(drawsFirst).not.toEqual(drawsOther);
    for (const draw of drawsFirst) {
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
  });
});

describe("informationCoefficient", () => {
  const perfect = Array.from({ length: 60 }, (_, index) => index);

  it("reports a tight interval excluding zero on a perfect relationship", () => {
    const measured = informationCoefficient(perfect, perfect, { seed: 7, bootstrapSamples: 200 });

    expect(measured.ic).toBeCloseTo(1, 10);
    expect(measured.sampleSize).toBe(60);
    expect(measured.confidenceInterval).not.toBeNull();
    expect(measured.confidenceInterval!.lower).toBeGreaterThan(0);
  });

  it("is deterministic for a fixed seed", () => {
    const random = createSeededRandom(99);
    const feature = Array.from({ length: 80 }, () => random());
    const forward = Array.from({ length: 80 }, () => random());

    const first = informationCoefficient(feature, forward, { seed: 5, bootstrapSamples: 300 });
    const second = informationCoefficient(feature, forward, { seed: 5, bootstrapSamples: 300 });

    expect(first.confidenceInterval).toEqual(second.confidenceInterval);
  });

  it("straddles zero on unrelated series", () => {
    const random = createSeededRandom(123);
    const feature = Array.from({ length: 300 }, () => random());
    const forward = Array.from({ length: 300 }, () => random());

    const measured = informationCoefficient(feature, forward, { seed: 3, bootstrapSamples: 400 });

    expect(measured.confidenceInterval).not.toBeNull();
    expect(measured.confidenceInterval!.lower).toBeLessThan(0);
    expect(measured.confidenceInterval!.upper).toBeGreaterThan(0);
  });

  it("skips the interval when the sample is too small to bootstrap", () => {
    const measured = informationCoefficient([1, 2, 3], [3, 2, 1], { seed: 1 });
    expect(measured.ic).toBeCloseTo(-1, 10);
    expect(measured.confidenceInterval).toBeNull();
  });

  it("reports an unmeasurable relationship as null", () => {
    const measured = informationCoefficient(new Array(40).fill(2), perfect.slice(0, 40), { seed: 1 });
    expect(measured.ic).toBeNull();
    expect(measured.confidenceInterval).toBeNull();
  });
});
