import { describe, expect, it } from "vitest";
import type { CausalCandle } from "./causal-pivot.js";
import { CisdTracker } from "./cisd.js";

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

function runAll(candles: readonly CausalCandle[]): { index: number; event: ReturnType<CisdTracker["processCandle"]> }[] {
  const tracker = new CisdTracker();
  const results: { index: number; event: ReturnType<CisdTracker["processCandle"]> }[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const event = tracker.processCandle(candles, i);
    if (event) results.push({ index: i, event });
  }
  return results;
}

describe("CisdTracker", () => {
  it("confirms a single-candle leg on the very same bar that clears it", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96), // bearish leg, open=100
      makeCandle(1, 96, 102, 95, 101), // bullish, closes 101 > 100 -> CISD same bar
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(1);
    expect(results[0].event).toMatchObject({ direction: "BULLISH", triggerLevel: 100 });
  });

  it("references the leg's FIRST candle's open, not its last, across a multi-candle leg", () => {
    const candles = [
      makeCandle(0, 110, 111, 104, 105), // leg starts, open=110 -- this is the reference, not 101
      makeCandle(1, 105, 106, 100, 101), // still bearish
      makeCandle(2, 101, 102, 96, 97),   // still bearish
      makeCandle(3, 97, 103, 96, 102),   // bullish, closes 102: clears the LAST candle's open (101) but not
                                         // the leg's own open (110) -- must not fire yet
      makeCandle(4, 102, 112, 101, 111), // bullish, closes 111 > 110 -> fires, referencing candle 0
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(4);
    expect(results[0].event).toMatchObject({
      direction: "BULLISH", triggerLevel: 110, legStartIndex: 0, legEndIndex: 2,
    });
  });

  it("ignores a wick-only poke past the level; only a body close counts", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96), // bearish leg, open=100
      makeCandle(1, 96, 105, 95, 99),  // high pokes to 105 (past 100) but closes at 99 -- not a CISD
      makeCandle(2, 99, 106, 98, 105), // closes at 105 > 100 -- fires here instead
    ];
    const results = runAll(candles);
    expect(results.map((r) => r.index)).toEqual([2]);
  });

  it("tracks a single generation only: a fresh reversal discards whatever leg was pending, even unconsummated", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96), // bearish leg #1, open=100
      makeCandle(1, 96, 99, 90, 92),   // extends leg #1
      makeCandle(2, 92, 98, 91, 97),   // bullish attempt (its own 1-candle leg, open=92); doesn't clear 100
      makeCandle(3, 97, 98, 94, 95),   // flips back bearish -- leg from candle 2 (open=92) is discarded
                                       // unconsummated; closes 95, which doesn't clear 92 either way
      makeCandle(4, 95, 96, 93, 94),   // extends the bearish run started at candle 3 (open=97)
      makeCandle(5, 94, 101, 93, 99.5), // bullish, closes 99.5: clears 97 (the run immediately preceding
                                        // THIS reversal) but not the long-discarded 100 -- fires at 97
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(5);
    expect(results[0].event).toMatchObject({ direction: "BULLISH", triggerLevel: 97 });
  });

  it("never revisits a discarded level later, even when price eventually crosses it too", () => {
    const tracker = new CisdTracker();
    const candles = [
      makeCandle(0, 100, 101, 95, 96),
      makeCandle(1, 96, 99, 90, 92),
      makeCandle(2, 92, 98, 91, 97),
      makeCandle(3, 97, 98, 94, 95),
      makeCandle(4, 95, 96, 93, 94),
      makeCandle(5, 94, 101, 93, 99.5), // consumes the 97 level here (see previous test)
      makeCandle(6, 99.5, 105, 99, 103), // bullish, closes 103 > 100 -- but 100 was discarded 3 bars ago
    ];
    for (let i = 0; i < candles.length - 1; i += 1) tracker.processCandle(candles, i);
    expect(tracker.processCandle(candles, candles.length - 1)).toBeNull();
  });

  it("confirms across several candles of the new run when the first bar doesn't clear the level", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96), // bearish leg, open=100
      makeCandle(1, 96, 99, 95, 98),   // bullish, closes 98 -- short of 100
      makeCandle(2, 98, 103, 97, 99),  // bullish, closes 99 -- still short
      makeCandle(3, 99, 105, 98, 104), // bullish, closes 104 > 100 -> fires on the third candle of the run
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(3);
    expect(results[0].event).toMatchObject({ direction: "BULLISH", triggerLevel: 100 });
  });

  it("mirrors symmetrically for a bearish CISD", () => {
    const candles = [
      makeCandle(0, 90, 96, 89, 95), // bullish leg, open=90
      makeCandle(1, 95, 97, 91, 92), // bearish, closes 92 -- above 90, no fire
      makeCandle(2, 92, 93, 85, 86), // bearish, closes 86 < 90 -> fires
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(2);
    expect(results[0].event).toMatchObject({ direction: "BEARISH", triggerLevel: 90 });
  });

  it("fires at most once per leg transition even if the new run keeps extending past the level", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96),
      makeCandle(1, 96, 112, 95, 111), // fires here
      makeCandle(2, 111, 120, 110, 118), // still bullish, well past 100 again -- must not re-fire
    ];
    const results = runAll(candles);
    expect(results.map((r) => r.index)).toEqual([1]);
  });

  it("treats a flat (doji) candle as inheriting the current run's direction, changing nothing", () => {
    const candles = [
      makeCandle(0, 100, 101, 95, 96), // bearish leg, open=100
      makeCandle(1, 96, 97, 94, 96),   // flat (close === open) -- a no-op for run tracking
      makeCandle(2, 96, 102, 95, 101), // bullish, closes 101 > 100 -> fires, referencing candle 0 still
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(2);
    expect(results[0].event).toMatchObject({ direction: "BULLISH", triggerLevel: 100, legStartIndex: 0 });
  });

  it("produces nothing on an opening flat candle with no established run yet", () => {
    const candles = [
      makeCandle(0, 100, 101, 99, 100), // flat, first candle -- nothing to establish
      makeCandle(1, 100, 105, 99, 104), // bullish -- starts the first real run, no leg to test against yet
    ];
    const results = runAll(candles);
    expect(results).toHaveLength(0);
  });

  it("prefix invariance: state at bar i is strictly identical whether later bars exist or not", () => {
    const candles = [
      makeCandle(0, 110, 111, 104, 105),
      makeCandle(1, 105, 106, 100, 101),
      makeCandle(2, 101, 102, 96, 97),
      makeCandle(3, 97, 103, 96, 102),
      makeCandle(4, 102, 112, 101, 111),
      makeCandle(5, 111, 118, 108, 109),
      makeCandle(6, 109, 110, 90, 92),
    ];

    const prefixTracker = new CisdTracker();
    let eventAt4Prefix: ReturnType<CisdTracker["processCandle"]> = null;
    for (let i = 0; i <= 4; i += 1) eventAt4Prefix = prefixTracker.processCandle(candles, i);

    const fullTracker = new CisdTracker();
    let eventAt4Full: ReturnType<CisdTracker["processCandle"]> = null;
    for (let i = 0; i < candles.length; i += 1) {
      const event = fullTracker.processCandle(candles, i);
      if (i === 4) eventAt4Full = event;
    }

    expect(eventAt4Prefix).toEqual(eventAt4Full);
  });
});
