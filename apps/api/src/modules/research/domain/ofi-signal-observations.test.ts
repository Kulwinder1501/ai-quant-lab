import { describe, expect, it } from "vitest";
import { buildOfiObservations } from "./ofi-signal-observations.js";
import type { OfiFrame } from "./order-flow-imbalance.js";

const T0 = Date.UTC(2026, 7, 24, 4, 0, 0);
const STEP_MS = 100;

/**
 * Frames 100ms apart. Bid size grows by `bidGrowth` each frame with prices pinned, so every OFI
 * increment is exactly `bidGrowth` and the expected sums are checkable by hand.
 */
function series(count: number, options: {
  bidGrowth?: number;
  gapAt?: number;
  snapshotAt?: number;
  duplicateAt?: number;
  askPriceDriftFrom?: number;
} = {}): OfiFrame[] {
  const bidGrowth = options.bidGrowth ?? 10;
  const frames: OfiFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const askPrice = options.askPriceDriftFrom !== undefined && index >= options.askPriceDriftFrom
      ? 101 + (index - options.askPriceDriftFrom) * 0.05
      : 101;
    frames.push({
      sequenceNo: 1_000 + index,
      receivedAt: new Date(T0 + index * STEP_MS),
      isSnapshot: index === 0 || index === options.snapshotAt,
      isDuplicate: index === options.duplicateAt,
      gapBefore: index === 0 ? null : (index === options.gapAt ? 5 : 0),
      bidPrice: [100],
      bidQty: [10 + index * bidGrowth],
      askPrice: [askPrice],
      askQty: [10],
    });
  }
  return frames;
}

describe("buildOfiObservations", () => {
  it("sums the trailing OFI window and pairs it with a forward return", () => {
    const frames = series(12, { askPriceDriftFrom: 6 });
    const result = buildOfiObservations({
      frames,
      ofiWindowMs: 300,
      horizonMs: 200,
      horizonToleranceMs: 50,
    });

    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.lookaheadViolations).toEqual([]);

    // Once warmed, a 300ms window at 100ms spacing holds four increments of +10.
    const warmed = result.observations.find((observation) =>
      observation.at.getTime() >= T0 + 4 * STEP_MS);
    expect(warmed!.featureValue).toBe(40);
  });

  it("stamps featureAsOf equal to the decision instant", () => {
    const result = buildOfiObservations({
      frames: series(10, { askPriceDriftFrom: 5 }),
      ofiWindowMs: 300,
      horizonMs: 200,
      horizonToleranceMs: 50,
    });

    for (const observation of result.observations) {
      expect(observation.featureAsOf.getTime()).toBe(observation.at.getTime());
    }
    expect(result.lookaheadViolations).toHaveLength(0);
  });

  it("truncates the feature window at a segment boundary rather than reaching through it", () => {
    // A gap at frame 5 restarts the OFI chain. The first observations after it must sum only
    // post-gap increments, even though a 300ms window would otherwise reach back across the hole.
    const frames = series(14, { gapAt: 5, askPriceDriftFrom: 7 });
    const result = buildOfiObservations({
      frames,
      ofiWindowMs: 1_000,
      horizonMs: 200,
      horizonToleranceMs: 50,
    });

    // The gap frame starts a new segment; its first increment is the diff from frame 5 to frame 6.
    const firstAfterGap = result.observations.find((observation) =>
      observation.at.getTime() === T0 + 6 * STEP_MS);
    expect(firstAfterGap).toBeDefined();
    // A 1000ms window would span frames 0-6 if it crossed the break; confined to the new segment it
    // can only hold the single +10 increment available so far.
    expect(firstAfterGap!.featureValue).toBe(10);
    expect(result.segmentsUsed).toBe(2);
  });

  it("measures the forward return across a break, unlike the feature", () => {
    // A price is a price. Refusing returns across gaps would drop exactly the volatile moments the
    // feed is likeliest to hiccup through, biasing the label.
    const frames = series(14, { gapAt: 8, askPriceDriftFrom: 2 });
    const result = buildOfiObservations({
      frames,
      ofiWindowMs: 300,
      horizonMs: 300,
      horizonToleranceMs: 50,
    });

    // An observation three frames before the gap has its endpoint on the far side of it.
    const spanning = result.observations.find((observation) =>
      observation.at.getTime() === T0 + 5 * STEP_MS);
    expect(spanning).toBeDefined();
    expect(spanning!.forwardReturn).not.toBe(0);
  });

  it("drops an observation when no frame lands inside the horizon tolerance", () => {
    const frames = series(6, { askPriceDriftFrom: 2 });
    const result = buildOfiObservations({
      frames,
      ofiWindowMs: 200,
      // 10s horizon over a series spanning 600ms: nothing can satisfy it.
      horizonMs: 10_000,
      horizonToleranceMs: 100,
    });

    expect(result.observations).toHaveLength(0);
    expect(result.skipped.NO_FORWARD_FRAME_IN_TOLERANCE).toBeGreaterThan(0);
  });

  it("requires the forward endpoint to be strictly later than the decision", () => {
    // Two frames share a millisecond. The endpoint must not be the same instant as the decision:
    // a same-stamp frame could have been processed either side of it.
    const frames: OfiFrame[] = [
      { sequenceNo: 1, receivedAt: new Date(T0), isSnapshot: true, isDuplicate: false, gapBefore: null,
        bidPrice: [100], bidQty: [10], askPrice: [101], askQty: [10] },
      { sequenceNo: 2, receivedAt: new Date(T0 + 100), isSnapshot: false, isDuplicate: false, gapBefore: 0,
        bidPrice: [100], bidQty: [20], askPrice: [101], askQty: [10] },
      { sequenceNo: 3, receivedAt: new Date(T0 + 100), isSnapshot: false, isDuplicate: false, gapBefore: 0,
        bidPrice: [100], bidQty: [30], askPrice: [101.5], askQty: [10] },
    ];

    const result = buildOfiObservations({
      frames, ofiWindowMs: 500, horizonMs: 0.0001, horizonToleranceMs: 1_000,
    });

    // The frame at T0+100 cannot serve as its own forward endpoint.
    const sameStamp = result.observations.find((observation) =>
      observation.at.getTime() === T0 + 100);
    expect(sameStamp?.forwardReturn ?? null).not.toBe(0);
  });

  it("skips a one-sided book instead of inventing a price", () => {
    const frames = series(8, { askPriceDriftFrom: 2 });
    // Blank the ask on one frame: microprice is undefined there.
    frames[4] = { ...frames[4]!, askPrice: [0], askQty: [0] };

    const result = buildOfiObservations({
      frames, ofiWindowMs: 300, horizonMs: 200, horizonToleranceMs: 50,
    });

    expect(result.skipped.UNREADABLE_MICROPRICE).toBeGreaterThan(0);
    for (const observation of result.observations) {
      expect(Number.isFinite(observation.forwardReturn)).toBe(true);
    }
  });

  it("expresses the return as a fraction of the base price", () => {
    const frames: OfiFrame[] = [
      { sequenceNo: 1, receivedAt: new Date(T0), isSnapshot: true, isDuplicate: false, gapBefore: null,
        bidPrice: [100], bidQty: [10], askPrice: [100], askQty: [10] },
      { sequenceNo: 2, receivedAt: new Date(T0 + 100), isSnapshot: false, isDuplicate: false, gapBefore: 0,
        bidPrice: [100], bidQty: [10], askPrice: [100], askQty: [10] },
      { sequenceNo: 3, receivedAt: new Date(T0 + 200), isSnapshot: false, isDuplicate: false, gapBefore: 0,
        bidPrice: [110], bidQty: [10], askPrice: [110], askQty: [10] },
    ];

    const result = buildOfiObservations({
      frames, ofiWindowMs: 500, horizonMs: 100, horizonToleranceMs: 50,
    });

    // Base microprice 100, forward 110 -> +10%.
    expect(result.observations[0]!.forwardReturn).toBeCloseTo(0.1, 10);
  });

  it("rejects nonsensical windows loudly", () => {
    const frames = series(4);
    expect(() => buildOfiObservations({ frames, ofiWindowMs: 0, horizonMs: 100 }))
      .toThrow(/ofiWindowMs must be positive/);
    expect(() => buildOfiObservations({ frames, ofiWindowMs: 100, horizonMs: -1 }))
      .toThrow(/horizonMs must be positive/);
  });

  it("reports what it examined so a thin build is visible", () => {
    const frames = series(12, { askPriceDriftFrom: 4 });
    const result = buildOfiObservations({
      frames, ofiWindowMs: 300, horizonMs: 200, horizonToleranceMs: 50,
    });

    expect(result.framesExamined).toBe(12);
    expect(result.segmentsUsed).toBe(1);
  });
});
