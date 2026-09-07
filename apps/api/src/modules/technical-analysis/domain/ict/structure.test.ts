import { describe, expect, it } from "vitest";
import type { CausalCandle } from "./causal-pivot.js";
import { IctStructureTracker, mergeInsideBars } from "./structure.js";

function makeCandle(index: number, open: number, high: number, low: number, close: number, volume: number = 100): CausalCandle {
  return {
    id: `candle-${index}`,
    openTime: new Date(Date.UTC(2026, 0, 1, 9, 15 + index * 5)),
    open,
    high,
    low,
    close,
    volume,
  };
}

describe("mergeInsideBars", () => {
  it("merges inside bars into previous mother candle without advancing mother bounds", () => {
    const candles: CausalCandle[] = [
      makeCandle(0, 100, 110, 90, 105),
      makeCandle(1, 105, 108, 92, 102), // Inside bar 0
      makeCandle(2, 102, 107, 95, 100), // Nested inside bar
      makeCandle(3, 100, 115, 85, 112), // Outside bar break
    ];

    const merged = mergeInsideBars(candles);
    expect(merged.length).toBe(2);
    expect(merged[0].id).toBe("candle-0");
    expect(merged[0].high).toBe(110);
    expect(merged[0].low).toBe(90);
    expect(merged[0].close).toBe(100); // latest close
    expect(merged[0].volume).toBe(300); // accumulated volume
    expect(merged[0].mergedCandleIds).toEqual(["candle-0", "candle-1", "candle-2"]);
    expect(merged[1].id).toBe("candle-3");
  });
});

describe("IctStructureTracker", () => {
  it("prefix invariance: state at bar i is strictly identical whether later bars exist or not", () => {
    const rawCandles: CausalCandle[] = [
      makeCandle(0, 100, 105, 95, 102),
      makeCandle(1, 102, 110, 100, 108),
      makeCandle(2, 108, 120, 107, 118), // Pivot High candidate
      makeCandle(3, 118, 116, 110, 112),
      makeCandle(4, 112, 114, 105, 107), // Confirms pivot at 2 (with pivotLength=2)
      makeCandle(5, 107, 108, 98, 100),
      makeCandle(6, 100, 105, 96, 102),
      makeCandle(7, 102, 125, 101, 124), // Breaks HH
    ];

    // Compute on prefix up to bar 4
    const trackerPrefix = new IctStructureTracker(2);
    let snapshotAt4Prefix;
    for (let i = 0; i <= 4; i++) {
      snapshotAt4Prefix = trackerPrefix.processCandle(rawCandles, i);
    }

    // Compute on full series, record snapshot at bar 4
    const trackerFull = new IctStructureTracker(2);
    let snapshotAt4Full;
    for (let i = 0; i < rawCandles.length; i++) {
      const snap = trackerFull.processCandle(rawCandles, i);
      if (i === 4) {
        snapshotAt4Full = snap;
      }
    }

    expect(snapshotAt4Prefix).toEqual(snapshotAt4Full);
  });

  it("differentiates body close BOS from wick-only SWEEP", () => {
    // Construct scenario where a confirmed HH is broken by wick only, then later by body
    const tracker = new IctStructureTracker(1);
    const candles: CausalCandle[] = [
      makeCandle(0, 100, 105, 95, 100),
      makeCandle(1, 100, 120, 98, 110), // Pivot High at 1 (price 120)
      makeCandle(2, 110, 115, 105, 108), // Confirms pivot at 1
      makeCandle(3, 108, 109, 100, 101),
    ];

    for (let i = 0; i < candles.length; i++) {
      tracker.processCandle(candles, i);
    }

    // Bar 4: Wick pierces 120 (high=122), but closes below (close=118) => SWEEP
    const sweepCandle = makeCandle(4, 101, 122, 100, 118);
    candles.push(sweepCandle);
    const sweepSnap = tracker.processCandle(candles, 4);
    expect(sweepSnap.lastEvent?.type).toBe("SWEEP");
    expect(sweepSnap.lastEvent?.isWickOnly).toBe(true);

    // Bar 5: Body closes above 120 (close=125) => BOS
    const bosCandle = makeCandle(5, 118, 126, 117, 125);
    candles.push(bosCandle);
    const bosSnap = tracker.processCandle(candles, 5);
    expect(bosSnap.lastEvent?.type).toBe("BOS");
    expect(bosSnap.lastEvent?.isWickOnly).toBe(false);
  });
});

describe("CHoCH-for-IDM substitution after a prior-day sweep", () => {
  /*
   * Lecture 5: when previous-day liquidity has been grabbed, the first swing on the left is labelled
   * CHoCH instead of IDM. That relabel is the mechanism -- it moves the level whose break flips the
   * frame much closer to price, so the swept low becomes buyable.
   *
   * All three cases drive the SAME candles and differ only in the sweep argument, so any difference
   * is attributable to the substitution alone. This fixture reaches BEARISH at bar 5 and would
   * otherwise assign a swing high at 108 as IDM on bar 8, with the CHoCH level left back at 117.
   */
  function drive(sweep?: "PDH" | "PDL") {
    const candles: CausalCandle[] = [
      makeCandle(0, 120, 122, 118, 119), makeCandle(1, 119, 121, 110, 111),
      makeCandle(2, 111, 113, 108, 112), makeCandle(3, 112, 116, 111, 115),
      makeCandle(4, 115, 117, 104, 105), makeCandle(5, 105, 107, 96, 97),
      makeCandle(6, 97, 106, 96, 105), makeCandle(7, 105, 108, 99, 100),
      makeCandle(8, 100, 102, 90, 91), makeCandle(9, 91, 99, 90, 98),
      makeCandle(10, 98, 100, 88, 89),
    ];
    const tracker = new IctStructureTracker(1);
    let snap = tracker.processCandle(candles, 0);
    for (let i = 1; i < candles.length; i += 1) {
      snap = tracker.processCandle(candles, i, i >= 8 ? sweep : undefined);
    }
    return snap;
  }

  it("assigns the first left swing to the IDM slot when nothing was swept", () => {
    const snap = drive(undefined);
    expect(snap.trend).toBe("BEARISH");
    expect(snap.idm?.price).toBe(108);
    expect(snap.chochLevel).toBe(117);
  });

  it("relabels it as the CHoCH level when the prior-day low was swept", () => {
    const snap = drive("PDL");
    expect(snap.trend).toBe("BEARISH");
    // Out of the IDM slot entirely, and the flip level moves from 117 down to 108 -- close enough
    // to price that breaking it is the reversal the lecture plans the entry around.
    expect(snap.idm).toBeNull();
    expect(snap.chochLevel).toBe(108);
  });

  it("is direction-paired: a swept prior-day HIGH does nothing to a bearish trend", () => {
    // A swept PDH implies a bearish reversal, which is not a frame flip for an already-bearish
    // trend. Feeding the wrong side must leave the labelling untouched.
    const wrongSide = drive("PDH");
    const control = drive(undefined);
    expect(wrongSide.idm?.price).toBe(control.idm?.price);
    expect(wrongSide.chochLevel).toBe(control.chochLevel);
  });
});
