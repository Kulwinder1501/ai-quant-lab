import { describe, expect, it } from "vitest";
import {
  accumulateOrderFlowImbalance,
  levelOrderFlowImbalance,
  multiLevelOrderFlowImbalance,
  type OfiFrame,
} from "./order-flow-imbalance.js";

function book(bid: [number, number][], ask: [number, number][]) {
  return {
    bidPrice: bid.map(([price]) => price),
    bidQty: bid.map(([, qty]) => qty),
    askPrice: ask.map(([price]) => price),
    askQty: ask.map(([, qty]) => qty),
  };
}

const AT = new Date("2026-08-21T09:15:00.000Z");

function frame(overrides: Partial<OfiFrame> & { sequenceNo: number }): OfiFrame {
  return {
    ...book([[100, 10]], [[101, 10]]),
    receivedAt: new Date(AT.getTime() + overrides.sequenceNo * 1_000),
    isSnapshot: false,
    isDuplicate: false,
    gapBefore: 0,
    ...overrides,
  };
}

describe("levelOrderFlowImbalance", () => {
  it("counts added size at an unchanged bid as buy pressure", () => {
    const previous = book([[100, 10]], [[101, 10]]);
    const current = book([[100, 25]], [[101, 10]]);
    expect(levelOrderFlowImbalance(previous, current, 0)).toBe(15);
  });

  it("counts removed size at an unchanged bid as sell pressure", () => {
    const previous = book([[100, 25]], [[101, 10]]);
    const current = book([[100, 10]], [[101, 10]]);
    expect(levelOrderFlowImbalance(previous, current, 0)).toBe(-15);
  });

  it("counts a whole new size when the bid ticks up", () => {
    // An improving bid is buy pressure worth its entire queue, not just the difference: the old
    // queue is no longer at the touch.
    const previous = book([[100, 10]], [[101, 10]]);
    const current = book([[100.5, 8]], [[101, 10]]);
    expect(levelOrderFlowImbalance(previous, current, 0)).toBe(8);
  });

  it("counts the departed queue when the bid ticks down", () => {
    const previous = book([[100, 10]], [[101, 10]]);
    const current = book([[99.5, 8]], [[101, 10]]);
    expect(levelOrderFlowImbalance(previous, current, 0)).toBe(-10);
  });

  it("mirrors the sign on the ask side", () => {
    // Size added to the ask is sell pressure.
    const previous = book([[100, 10]], [[101, 10]]);
    const addedAsk = book([[100, 10]], [[101, 30]]);
    expect(levelOrderFlowImbalance(previous, addedAsk, 0)).toBe(-20);

    // An ask improving downward is sell pressure worth its whole queue.
    const betterAsk = book([[100, 10]], [[100.5, 7]]);
    expect(levelOrderFlowImbalance(previous, betterAsk, 0)).toBe(-7);

    // An ask retreating upward removes that pressure.
    const worseAsk = book([[100, 10]], [[101.5, 7]]);
    expect(levelOrderFlowImbalance(previous, worseAsk, 0)).toBe(10);
  });

  it("is zero for an unchanged book", () => {
    const same = book([[100, 10]], [[101, 10]]);
    expect(levelOrderFlowImbalance(same, same, 0)).toBe(0);
  });

  it("sums both sides when both move", () => {
    const previous = book([[100, 10]], [[101, 10]]);
    const current = book([[100, 20]], [[101, 15]]);
    // +10 on the bid, -5 on the ask.
    expect(levelOrderFlowImbalance(previous, current, 0)).toBe(5);
  });

  it("returns null rather than treating an absent level as a zero price", () => {
    // A level appearing from nothing would otherwise read as an infinite price improvement.
    const previous = book([[100, 10]], [[101, 10]]);
    const deeper = book([[100, 10], [99, 5]], [[101, 10], [102, 5]]);
    expect(levelOrderFlowImbalance(previous, deeper, 1)).toBeNull();
    expect(levelOrderFlowImbalance(deeper, previous, 1)).toBeNull();
  });
});

describe("multiLevelOrderFlowImbalance", () => {
  it("sums the comparable levels and counts them", () => {
    const previous = book([[100, 10], [99, 10]], [[101, 10], [102, 10]]);
    const current = book([[100, 15], [99, 4]], [[101, 10], [102, 10]]);

    const result = multiLevelOrderFlowImbalance(previous, current, 2);
    expect(result.perLevel).toEqual([5, -6]);
    expect(result.total).toBe(-1);
    expect(result.levelsCompared).toBe(2);
  });

  it("skips levels that are not comparable without discarding the rest", () => {
    const previous = book([[100, 10]], [[101, 10]]);
    const current = book([[100, 15]], [[101, 10]]);

    const result = multiLevelOrderFlowImbalance(previous, current, 3);
    expect(result.perLevel).toEqual([5, null, null]);
    expect(result.total).toBe(5);
    expect(result.levelsCompared).toBe(1);
  });

  it("reports a null total when no level was comparable", () => {
    const empty = book([], []);
    const result = multiLevelOrderFlowImbalance(empty, empty, 2);
    expect(result.total).toBeNull();
    expect(result.levelsCompared).toBe(0);
  });

  it("rejects a nonsensical level count", () => {
    const same = book([[100, 10]], [[101, 10]]);
    expect(() => multiLevelOrderFlowImbalance(same, same, 0)).toThrow(/positive integer/);
  });
});

describe("accumulateOrderFlowImbalance", () => {
  it("accumulates a clean chain into one segment", () => {
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([[100, 20]], [[101, 10]]) }),
      frame({ sequenceNo: 3, ...book([[100, 25]], [[101, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.segments).toHaveLength(1);
    expect(result.observations).toBe(2);
    expect(result.segments[0]!.observations.map((o) => o.delta)).toEqual([10, 5]);
    expect(result.segments[0]!.observations.map((o) => o.cumulative)).toEqual([10, 15]);
    expect(result.breaks).toHaveLength(0);
  });

  it("does not difference across a sequence gap", () => {
    // The reason Phase 1 stored gapBefore. Differencing across a hole would attribute every unseen
    // queue change to one update, and the running sum would inherit the error forever after.
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([[100, 20]], [[101, 10]]) }),
      frame({ sequenceNo: 9, gapBefore: 6, ...book([[100, 500]], [[101, 10]]) }),
      frame({ sequenceNo: 10, ...book([[100, 505]], [[101, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]!.cause).toBe("SEQUENCE_GAP");
    expect(result.breaks[0]!.missedSequences).toBe(6);
    // Two segments; the +480 jump across the hole never becomes an observation.
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.observations.map((o) => o.delta)).toEqual([10]);
    expect(result.segments[1]!.observations.map((o) => o.delta)).toEqual([5]);
    expect(result.observations).toBe(2);
  });

  it("does not difference across a snapshot", () => {
    // A snapshot restates the book. Differencing across it would invent an enormous imbalance.
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([[100, 20]], [[101, 10]]) }),
      frame({ sequenceNo: 3, isSnapshot: true, gapBefore: null, ...book([[200, 900]], [[201, 10]]) }),
      frame({ sequenceNo: 4, ...book([[200, 950]], [[201, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.breaks.map((entry) => entry.cause)).toEqual(["SNAPSHOT"]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[1]!.startedBecause).toBe("SNAPSHOT");
    expect(result.segments[1]!.observations.map((o) => o.delta)).toEqual([50]);
  });

  it("skips a duplicate rather than double-counting its flow", () => {
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([[100, 20]], [[101, 10]]) }),
      frame({ sequenceNo: 2, isDuplicate: true, ...book([[100, 20]], [[101, 10]]) }),
      frame({ sequenceNo: 3, ...book([[100, 30]], [[101, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.breaks.map((entry) => entry.cause)).toEqual(["DUPLICATE"]);
    // The duplicate is not used as a baseline either, so the +10 from seq 2 to seq 3 survives
    // intact in the next segment rather than being measured against a stale copy.
    expect(result.segments[result.segments.length - 1]!.observations.map((o) => o.delta))
      .toEqual([10]);
    expect(result.observations).toBe(2);
  });

  it("breaks the chain on an unreadable book", () => {
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([], []) }),
      frame({ sequenceNo: 3, ...book([[100, 10]], [[101, 10]]) }),
      frame({ sequenceNo: 4, ...book([[100, 40]], [[101, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.breaks.some((entry) => entry.cause === "NOT_COMPARABLE")).toBe(true);
    expect(result.segments.at(-1)!.observations.map((o) => o.delta)).toEqual([30]);
  });

  it("reports the longest usable stretch, which is what a window feature has to work with", () => {
    const frames: OfiFrame[] = [
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
      frame({ sequenceNo: 2, ...book([[100, 11]], [[101, 10]]) }),
      frame({ sequenceNo: 5, gapBefore: 2, ...book([[100, 12]], [[101, 10]]) }),
      frame({ sequenceNo: 6, ...book([[100, 13]], [[101, 10]]) }),
      frame({ sequenceNo: 7, ...book([[100, 14]], [[101, 10]]) }),
      frame({ sequenceNo: 8, ...book([[100, 15]], [[101, 10]]) }),
    ];

    const result = accumulateOrderFlowImbalance(frames);

    expect(result.framesExamined).toBe(6);
    expect(result.longestSegment).toBe(3);
  });

  it("contributes nothing from a single frame, having nothing to difference", () => {
    const result = accumulateOrderFlowImbalance([
      frame({ sequenceNo: 1, isSnapshot: true, gapBefore: null }),
    ]);
    expect(result.segments).toHaveLength(0);
    expect(result.observations).toBe(0);
    expect(result.longestSegment).toBe(0);
  });

  it("handles an empty series", () => {
    const result = accumulateOrderFlowImbalance([]);
    expect(result.segments).toHaveLength(0);
    expect(result.breaks).toHaveLength(0);
    expect(result.framesExamined).toBe(0);
  });

  it("uses deeper levels when asked", () => {
    const frames: OfiFrame[] = [
      frame({
        sequenceNo: 1, isSnapshot: true, gapBefore: null,
        ...book([[100, 10], [99, 10]], [[101, 10], [102, 10]]),
      }),
      frame({ sequenceNo: 2, ...book([[100, 15], [99, 18]], [[101, 10], [102, 10]]) }),
    ];

    const touchOnly = accumulateOrderFlowImbalance(frames, { levels: 1 });
    const twoLevels = accumulateOrderFlowImbalance(frames, { levels: 2 });

    expect(touchOnly.segments[0]!.observations[0]!.delta).toBe(5);
    expect(twoLevels.segments[0]!.observations[0]!.delta).toBe(13);
  });
});
