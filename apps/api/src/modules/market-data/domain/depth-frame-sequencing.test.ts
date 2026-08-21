import { describe, expect, it } from "vitest";
import {
  classifySequence,
  summariseSequenceHealth,
  type ClassifiedFrame,
} from "./depth-frame-sequencing.js";

describe("classifySequence", () => {
  it("reports a contiguous frame as gapBefore 0", () => {
    expect(classifySequence({ sequenceNo: 101, previousSequenceNo: 100, isSnapshot: false }))
      .toEqual({ gapBefore: 0, isDuplicate: false, isRegression: false });
  });

  it("counts the sequence numbers actually skipped", () => {
    // 100 -> 104 means 101, 102 and 103 never arrived.
    expect(classifySequence({ sequenceNo: 104, previousSequenceNo: 100, isSnapshot: false }).gapBefore)
      .toBe(3);
  });

  it("flags a replayed sequence number as a duplicate", () => {
    expect(classifySequence({ sequenceNo: 100, previousSequenceNo: 100, isSnapshot: false }))
      .toEqual({ gapBefore: 0, isDuplicate: true, isRegression: false });
  });

  it("flags a lower sequence number as a regression rather than a negative gap", () => {
    const classified = classifySequence({
      sequenceNo: 90, previousSequenceNo: 100, isSnapshot: false,
    });
    expect(classified.isRegression).toBe(true);
    expect(classified.gapBefore).toBeNull();
  });

  it("does not treat a snapshot jump as loss", () => {
    // The most likely false alarm in this module: the feed re-bases on snapshot, so the sequence
    // number can jump arbitrarily and legitimately. Calling that a 4,899-frame gap would report a
    // healthy reconnect as a broken feed.
    const classified = classifySequence({
      sequenceNo: 5_000, previousSequenceNo: 100, isSnapshot: true,
    });
    expect(classified.gapBefore).toBeNull();
    expect(classified.isDuplicate).toBe(false);
    expect(classified.isRegression).toBe(false);
  });

  it("reports nothing comparable for the first frame of a stream", () => {
    expect(classifySequence({ sequenceNo: 100, previousSequenceNo: null, isSnapshot: false }).gapBefore)
      .toBeNull();
  });

  it("reports nothing comparable when the frame carries no sequence number", () => {
    // Not counted as contiguous: inflating the contiguous tally with unknowns would flatter the rate.
    expect(classifySequence({ sequenceNo: null, previousSequenceNo: 100, isSnapshot: false }).gapBefore)
      .toBeNull();
  });

  it("rejects a negative sequence number as unusable", () => {
    expect(classifySequence({ sequenceNo: -5, previousSequenceNo: 100, isSnapshot: false }).gapBefore)
      .toBeNull();
  });
});

describe("summariseSequenceHealth", () => {
  function frames(count: number, produce: (index: number) => Partial<ClassifiedFrame>): ClassifiedFrame[] {
    return Array.from({ length: count }, (_, index) => ({
      gapBefore: 0,
      isDuplicate: false,
      isRegression: false,
      isSnapshot: false,
      sequenceNo: index,
      ...produce(index),
    }));
  }

  it("reports RECONSTRUCTIBLE on a clean capture", () => {
    const health = summariseSequenceHealth(frames(2_000, () => ({})));

    expect(health.verdict).toBe("RECONSTRUCTIBLE");
    expect(health.comparablePairs).toBe(2_000);
    expect(health.contiguousFrames).toBe(2_000);
    expect(health.missedSequences).toBe(0);
    expect(health.missedSequenceRate).toBe(0);
    expect(health.largestGap).toBe(0);
  });

  it("refuses to publish a rate on a thin capture", () => {
    // A gap rate over a few dozen frames is not a characterisation of a feed.
    const health = summariseSequenceHealth(frames(50, () => ({})));

    expect(health.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(health.comparablePairs).toBe(50);
  });

  it("reports FEED_NOT_RECONSTRUCTIBLE when too much of the stream is missing", () => {
    // 2,000 frames, every tenth preceded by a 5-frame burst: 1,000 missed against 2,000 seen.
    const health = summariseSequenceHealth(
      frames(2_000, (index) => (index % 10 === 0 ? { gapBefore: 5 } : {})),
    );

    expect(health.verdict).toBe("FEED_NOT_RECONSTRUCTIBLE");
    expect(health.missedSequences).toBe(1_000);
    expect(health.gapEvents).toBe(200);
    expect(health.largestGap).toBe(5);
    expect(health.missedSequenceRate).toBeCloseTo(1_000 / 3_000, 6);
  });

  it("reports DEGRADED between the two thresholds", () => {
    // Two single-frame losses in 2,000 comparable frames is ~0.1%, above degraded and well below
    // the reconstruction limit.
    const health = summariseSequenceHealth(
      frames(2_000, (index) => (index === 100 || index === 900 ? { gapBefore: 2 } : {})),
    );

    expect(health.verdict).toBe("DEGRADED");
    expect(health.missedSequenceRate!).toBeGreaterThan(0.001);
    expect(health.missedSequenceRate!).toBeLessThan(0.01);
  });

  it("separates a burst from scattered losses at equal event rate", () => {
    // The distinction the header argues for: same gapEventRate, very different missedSequenceRate,
    // because OFI is a cumulative sum and a burst corrupts a longer stretch of the book.
    const scattered = summariseSequenceHealth(
      frames(2_000, (index) => (index % 100 === 0 ? { gapBefore: 1 } : {})),
    );
    const burst = summariseSequenceHealth(
      frames(2_000, (index) => (index % 100 === 0 ? { gapBefore: 40 } : {})),
    );

    expect(scattered.gapEventRate).toBeCloseTo(burst.gapEventRate!, 10);
    expect(burst.missedSequenceRate!).toBeGreaterThan(scattered.missedSequenceRate! * 10);
    expect(scattered.verdict).toBe("DEGRADED");
    expect(burst.verdict).toBe("FEED_NOT_RECONSTRUCTIBLE");
  });

  it("excludes uncomparable frames from the denominator", () => {
    const health = summariseSequenceHealth([
      { gapBefore: null, isDuplicate: false, isRegression: false, isSnapshot: true, sequenceNo: 1 },
      { gapBefore: 0, isDuplicate: false, isRegression: false, isSnapshot: false, sequenceNo: 2 },
      { gapBefore: null, isDuplicate: false, isRegression: true, isSnapshot: false, sequenceNo: 1 },
      { gapBefore: null, isDuplicate: false, isRegression: false, isSnapshot: false, sequenceNo: null },
    ]);

    expect(health.framesExamined).toBe(4);
    expect(health.framesWithSequence).toBe(3);
    expect(health.comparablePairs).toBe(1);
    expect(health.snapshots).toBe(1);
    expect(health.regressions).toBe(1);
  });

  it("counts duplicates without treating them as missing data", () => {
    const health = summariseSequenceHealth(
      frames(1_000, (index) => (index % 100 === 0 ? { gapBefore: 0, isDuplicate: true } : {})),
    );

    expect(health.duplicates).toBe(10);
    expect(health.missedSequences).toBe(0);
    expect(health.verdict).toBe("RECONSTRUCTIBLE");
  });

  it("echoes the thresholds it judged against", () => {
    const health = summariseSequenceHealth(frames(600, () => ({})), {
      degradedRate: 0.5,
      notReconstructibleRate: 0.9,
      minimumComparablePairs: 100,
    });

    expect(health.thresholds).toEqual({
      degradedRate: 0.5,
      notReconstructibleRate: 0.9,
      minimumComparablePairs: 100,
    });
    expect(health.verdict).toBe("RECONSTRUCTIBLE");
  });

  it("handles an empty capture without dividing by zero", () => {
    const health = summariseSequenceHealth([]);
    expect(health.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(health.gapEventRate).toBeNull();
    expect(health.missedSequenceRate).toBeNull();
  });
});
