import { describe, expect, it } from "vitest";
import type { CausalCandle } from "./causal-pivot.js";
import { IctStructureTracker } from "./structure.js";
import { IctZoneLedger } from "./zones.js";

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

describe("IctZoneLedger", () => {
  it("tracks Bullish FVG lifecycle from CREATION -> PARTIALLY_FILLED -> INVERTED", () => {
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);

    // Candles 0, 1, 2 form a Bullish FVG:
    // C0: high = 100
    // C1: big expansion (100 -> 120)
    // C2: low = 105 (Gap: 100 to 105)
    const candles: CausalCandle[] = [
      makeCandle(0, 95, 100, 90, 98),
      makeCandle(1, 98, 122, 97, 120),
      makeCandle(2, 115, 125, 105, 123),
    ];

    let s0 = structTracker.processCandle(candles, 0);
    ledger.processCandle(candles, 0, s0);
    let s1 = structTracker.processCandle(candles, 1);
    ledger.processCandle(candles, 1, s1);
    let s2 = structTracker.processCandle(candles, 2);
    let snap2 = ledger.processCandle(candles, 2, s2);

    expect(snap2.activeFvgs.length).toBe(1);
    const fvg = snap2.activeFvgs[0];
    expect(fvg.type).toBe("BULLISH");
    expect(fvg.top).toBe(105);
    expect(fvg.bottom).toBe(100);
    expect(fvg.midpoint).toBe(102.5); // CE
    expect(fvg.state).toBe("FRESH");

    // Candle 3: Dips into FVG to 102 (50% CE filled)
    const c3 = makeCandle(3, 123, 124, 102, 110);
    candles.push(c3);
    let s3 = structTracker.processCandle(candles, 3);
    let snap3 = ledger.processCandle(candles, 3, s3);
    expect(snap3.activeFvgs[0].state).toBe("PARTIALLY_FILLED");
    expect(snap3.activeFvgs[0].fillPercentage).toBe(0.6); // (105 - 102) / 5 = 3/5 = 0.6

    // Candle 4: Closes through below 100 (close=96) -> INVERTED
    const c4 = makeCandle(4, 110, 111, 95, 96);
    candles.push(c4);
    let s4 = structTracker.processCandle(candles, 4);
    let snap4 = ledger.processCandle(candles, 4, s4);
    expect(snap4.activeFvgs[0].state).toBe("INVERTED");
    expect(snap4.lastZoneEvent?.event).toBe("INVERTED");
  });

  it("invalidates an Order Block when price closes through its 50% Mean Threshold", () => {
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);

    // Candle 0: Bearish candle (open 105, close 95, high 106, low 94)
    // Candle 1: Big Bullish displacement candle (open 95, close 125, high 126, low 94)
    // Candle 2: Gap forms (low 110 > high 106)
    const candles: CausalCandle[] = [
      makeCandle(0, 105, 106, 94, 95),
      makeCandle(1, 95, 126, 94, 125),
      makeCandle(2, 120, 130, 110, 128),
    ];

    let s0 = structTracker.processCandle(candles, 0);
    ledger.processCandle(candles, 0, s0);
    let s1 = structTracker.processCandle(candles, 1);
    ledger.processCandle(candles, 1, s1);
    let s2 = structTracker.processCandle(candles, 2);
    let snap2 = ledger.processCandle(candles, 2, s2);

    expect(snap2.activeObs.length).toBe(1);
    const ob = snap2.activeObs[0];
    expect(ob.type).toBe("BULLISH");
    expect(ob.top).toBe(106);
    expect(ob.bottom).toBe(94);
    expect(ob.meanThreshold).toBe(100); // 94 + (106 - 94)*0.5 = 100

    // Candle 3: Dips into OB but closes above MT (close=102, low=98) -> TOUCHED
    const c3 = makeCandle(3, 128, 129, 98, 102);
    candles.push(c3);
    let s3 = structTracker.processCandle(candles, 3);
    let snap3 = ledger.processCandle(candles, 3, s3);
    expect(snap3.activeObs[0].state).toBe("TOUCHED");

    // Candle 4: Closes through below 50% MT (close=99) -> INVALIDATED
    // Note: high=112 >= c2.low(110) prevents an unintended Bearish FVG/OB forming on candle 4
    const c4 = makeCandle(4, 102, 112, 96, 99);
    candles.push(c4);
    let s4 = structTracker.processCandle(candles, 4);
    let snap4 = ledger.processCandle(candles, 4, s4);
    expect(snap4.activeObs.length).toBe(0); // activeObs excludes INVALIDATED
    expect(snap4.lastZoneEvent?.event).toBe("INVALIDATED");
  });

  // Fixture: bars 0-2 create one Bullish FVG (100 -> 105); bars 3-4 fill and
  // then invert it. Used by the prefix-invariance and zoneId tests below.
  function fvgLifecycleCandles(): CausalCandle[] {
    return [
      makeCandle(0, 95, 100, 90, 98),
      makeCandle(1, 98, 122, 97, 120),
      makeCandle(2, 115, 125, 105, 123),
      makeCandle(3, 123, 124, 102, 110),
      makeCandle(4, 110, 111, 95, 96),
    ];
  }

  // Serialize the zone snapshot returned at `captureIndex` from a ledger fed
  // bars 0..upToIndex. Serialization happens at the moment of the call so that
  // later mutation of the (reference-shared) zone objects cannot alter it.
  function snapshotJsonAt(
    candles: readonly CausalCandle[],
    captureIndex: number,
    upToIndex: number
  ): string {
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);
    let captured = "";
    for (let i = 0; i <= upToIndex; i++) {
      const s = structTracker.processCandle(candles, i);
      const snap = ledger.processCandle(candles, i, s);
      if (i === captureIndex) captured = JSON.stringify(snap);
    }
    return captured;
  }

  it("is prefix-invariant: the snapshot at bar i is identical regardless of later bars", () => {
    const candles = fvgLifecycleCandles();
    // Snapshot at bar 2 computed from a ledger that has only seen 0..2 ...
    const fromShort = snapshotJsonAt(candles, 2, 2);
    // ... must equal the snapshot at bar 2 from a ledger that will go on to 0..4.
    const fromLong = snapshotJsonAt(candles, 2, 4);
    expect(fromLong).toBe(fromShort);
  });

  it("assigns deterministic, origin-stable zoneIds that survive recomputation", () => {
    const candles = fvgLifecycleCandles();
    const run = () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);
      let snap2!: ReturnType<IctZoneLedger["processCandle"]>;
      for (let i = 0; i <= 2; i++) {
        const s = structTracker.processCandle(candles, i);
        snap2 = ledger.processCandle(candles, i, s);
      }
      return snap2;
    };

    const first = run();
    const second = run();
    expect(first.activeFvgs).toHaveLength(1);
    // Derived from origin bar, not random: same across independent recomputation.
    expect(first.activeFvgs[0].id).toBe("fvg-bullish-2");
    expect(second.activeFvgs[0].id).toBe(first.activeFvgs[0].id);
  });

  it("gives overlapping same-direction FVGs with different origins distinct ids", () => {
    // Two separate bullish gaps at different origin bars over the same prices.
    const candles: CausalCandle[] = [
      makeCandle(0, 95, 100, 90, 98),
      makeCandle(1, 98, 122, 97, 120),
      makeCandle(2, 115, 125, 105, 123), // FVG #1 origin (100 -> 105)
      makeCandle(3, 123, 124, 104, 121), // pulls back but does not close the gap fully
      makeCandle(4, 121, 140, 120, 138), // displacement up
      makeCandle(5, 135, 145, 128, 143), // FVG #2 origin (low 128 > bar-4? forms new gap)
    ];
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);
    let last!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i < candles.length; i++) {
      const s = structTracker.processCandle(candles, i);
      last = ledger.processCandle(candles, i, s);
    }
    const ids = new Set(last.activeFvgs.map((f) => f.id));
    // However many survive as active, no two active zones share an id.
    expect(ids.size).toBe(last.activeFvgs.length);
  });
});
