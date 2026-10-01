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
  it("tracks Bullish FVG lifecycle from CREATION -> PARTIALLY_FILLED -> re-entry as BEARISH", () => {
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

    // Candle 4: closes clean below 100, so the gap inverts.
    //
    // It used to stay in the list as state INVERTED while still reporting type BULLISH, which meant
    // the strategy was offered a long at a level that had just failed as support. It now re-enters as
    // a NEW gap carrying the flipped type -- dated to this bar, so a snapshot taken earlier cannot
    // contain it, which reading the mutable `state` at the point of use would not have avoided.
    const c4 = makeCandle(4, 110, 111, 95, 96);
    candles.push(c4);
    let s4 = structTracker.processCandle(candles, 4);
    let snap4 = ledger.processCandle(candles, 4, s4);
    expect(snap4.lastZoneEvent?.event).toBe("INVERTED");

    const survivors = snap4.activeFvgs.filter((f) => f.id.startsWith("fvg-bullish-2"));
    expect(survivors).toHaveLength(1);
    const inverted = survivors[0];
    expect(inverted.id).toBe("fvg-bullish-2-inv");
    expect(inverted.type).toBe("BEARISH");
    expect(inverted.state).toBe("FRESH");
    expect(inverted.top).toBe(105);
    expect(inverted.bottom).toBe(100);
    expect(inverted.createdAtBarIndex).toBe(4);
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

  it("finds the true order block even when the displacement takes 2+ candles to clear a gap", () => {
    // C0: bearish "last selling candle" before the rally -- the real order block, range 94-106.
    // C1: a small bullish pause candle whose high (97) does NOT clear C0's high (106).
    // C2: the big bullish displacement candle.
    // C3: confirms, and is the bar whose 3-candle window (C1, C2, C3) first sees a gap -- but C1
    // (not C0) sits exactly 2 bars back from it, and C1 is itself bullish, not the opposing candle.
    // Before the backward search this silently produced zero order blocks despite a real, valid FVG.
    const candles: CausalCandle[] = [
      makeCandle(0, 105, 106, 94, 95),
      makeCandle(1, 95, 97, 94, 96),
      makeCandle(2, 96, 125, 95, 123),
      makeCandle(3, 123, 130, 110, 128),
    ];
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);

    let snap!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i < candles.length; i++) {
      const s = structTracker.processCandle(candles, i);
      snap = ledger.processCandle(candles, i, s);
    }

    expect(snap.activeFvgs).toHaveLength(1);
    expect(snap.activeFvgs[0].type).toBe("BULLISH");

    expect(snap.activeObs).toHaveLength(1);
    const ob = snap.activeObs[0];
    expect(ob.type).toBe("BULLISH");
    // Anchored on C0 (the real last selling candle), not C1 (the pause candle 2 bars back).
    expect(ob.obCandleIndex).toBe(0);
    expect(ob.top).toBe(106);
    expect(ob.bottom).toBe(94);
    expect(ob.meanThreshold).toBe(100);
  });

  it("still fails closed when no opposing candle exists within the lookback bound", () => {
    // Every candle from the search start backward is the SAME direction as the displacement, so
    // the walk should exhaust its bound and produce no order block -- not anchor on an unrelated,
    // same-direction candle far out of range.
    const candles: CausalCandle[] = [];
    // 12 bullish "pause" candles, each with a slightly higher high, none of them opposing.
    for (let i = 0; i < 12; i += 1) {
      candles.push(makeCandle(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    // Displacement + confirmation, forming a valid FVG against candle index (candles.length - 3).
    candles.push(makeCandle(12, 111.5, 140, 111, 138));
    candles.push(makeCandle(13, 138, 150, 135, 145));

    const ledger = new IctZoneLedger(1.5, 0.5, false, 10); // lookback bound of 10 bars
    const structTracker = new IctStructureTracker(2);

    let snap!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i < candles.length; i++) {
      const s = structTracker.processCandle(candles, i);
      snap = ledger.processCandle(candles, i, s);
    }

    expect(snap.activeFvgs.length).toBeGreaterThan(0);
    expect(snap.activeObs).toHaveLength(0);
  });

  it("does not spawn a duplicate order block while the first at that anchor is still active", () => {
    // Measured on real 2025 data before this guard: 164 of 628 unique BANKNIFTY anchor candles had
    // spawned 2+ separate order-block objects (216 pure duplicates), because a slow grind can open a
    // fresh 2-bar-lookback gap on several consecutive bars that all walk back to the SAME true
    // opposing candle via `findOrderBlockCandle`. Bars 4 and 5 below each independently trigger a new
    // FVG whose backward search resolves to candle 0 -- same anchor, same direction -- while the
    // original block from bar 3 is still FRESH; only one order block may exist there at a time.
    const candles: CausalCandle[] = [
      makeCandle(0, 105, 106, 94, 95),   // true OB candle (bearish)
      makeCandle(1, 95, 97, 94, 96),     // pause
      makeCandle(2, 96, 125, 95, 123),   // displacement -> FVG+OB at bar 3, anchored at candle 0
      makeCandle(3, 123, 130, 110, 128), // confirms
      makeCandle(4, 131, 150, 130, 148), // pause -- its own FVG search also resolves back to candle 0
      makeCandle(5, 148, 170, 135, 165), // displacement -- same anchor again; must NOT duplicate
    ];
    const ledger = new IctZoneLedger();
    const structTracker = new IctStructureTracker(2);

    let snap!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i < candles.length; i++) {
      const s = structTracker.processCandle(candles, i);
      snap = ledger.processCandle(candles, i, s);
    }

    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].id).toBe("ob-bullish-3");
    expect(snap.activeObs[0].obCandleIndex).toBe(0);
  });

  it("allows a genuinely new order block to re-form at the same anchor once the first is invalidated", () => {
    // Continues the fixture above: candle 6 trades through the bar-3 block's mean threshold and
    // invalidates it, freeing the anchor. Candles 7-8 then form a fresh displacement whose backward
    // search resolves to the SAME candle 0 -- this time a new order block IS created, because
    // nothing active occupies that anchor any more. This is the real-data case this dedup guard must
    // not break: `ob-bearish-74` (anchored at candle 70 in a live NIFTY50 run) was invalidated at bar
    // 75 and a genuinely new block re-formed at the same anchor at bar 77.
    const candles: CausalCandle[] = [
      makeCandle(0, 105, 106, 94, 95),
      makeCandle(1, 95, 97, 94, 96),
      makeCandle(2, 96, 125, 95, 123),
      makeCandle(3, 123, 130, 110, 128),
      makeCandle(4, 131, 150, 130, 148),
      makeCandle(5, 148, 170, 135, 165),
      makeCandle(6, 90, 105, 88, 98),    // touches (low <= 106) and closes below meanThreshold(100) -> invalidates ob-bullish-3
      makeCandle(7, 98, 140, 96, 135),   // pause -- big body, bullish
      makeCandle(8, 135, 145, 110, 142), // displacement -- resolves to candle 0 again, now free
    ];
    const ledger = new IctZoneLedger();
    const structTracker = new IctStructureTracker(2);

    let snap!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i < candles.length; i++) {
      const s = structTracker.processCandle(candles, i);
      snap = ledger.processCandle(candles, i, s);
    }

    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].id).toBe("ob-bullish-8");
    expect(snap.activeObs[0].obCandleIndex).toBe(0);
  });

  it("never mutates an order block object already handed out (TOUCHED leak)", () => {
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);

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
    const snap2 = ledger.processCandle(candles, 2, s2);

    const obHandedOutAtBar2 = snap2.activeObs[0];
    expect(obHandedOutAtBar2.state).toBe("FRESH");

    // Candle 3 touches the block (see the OB invalidation test above) -> TOUCHED on the ledger's
    // internal copy. The object captured at bar 2 must not follow it.
    const c3 = makeCandle(3, 128, 129, 98, 102);
    candles.push(c3);
    const s3 = structTracker.processCandle(candles, 3);
    ledger.processCandle(candles, 3, s3);

    expect(obHandedOutAtBar2.state).toBe("FRESH");
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
  // bars 0..upToIndex.
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

  it("never mutates a zone object already handed out in an earlier snapshot (the batch/replay leak)", () => {
    // This is the defect the batch replay builder hit: it stores every bar's snapshot in an array
    // before any of them is read, so if a zone object were mutated in place on a later bar, an
    // EARLIER snapshot's own object -- the very same reference, not a copy -- would silently read
    // the later bar's values once the whole run finished. Capturing the live object (not JSON) and
    // re-checking it after the ledger keeps advancing is what would have caught that.
    const candles = fvgLifecycleCandles();
    const ledger = new IctZoneLedger(1.5, 0.5);
    const structTracker = new IctStructureTracker(2);

    let snapshotAtBar2!: ReturnType<IctZoneLedger["processCandle"]>;
    for (let i = 0; i <= 2; i++) {
      const s = structTracker.processCandle(candles, i);
      snapshotAtBar2 = ledger.processCandle(candles, i, s);
    }
    const fvgHandedOutAtBar2 = snapshotAtBar2.activeFvgs[0];
    expect(fvgHandedOutAtBar2.fillPercentage).toBe(0);
    expect(fvgHandedOutAtBar2.state).toBe("FRESH");

    // Bars 3-4 partially fill and then invert the same gap -- exactly the transitions that used to
    // mutate the object in place.
    for (let i = 3; i <= 4; i++) {
      const s = structTracker.processCandle(candles, i);
      ledger.processCandle(candles, i, s);
    }

    // The object reference captured at bar 2 must be untouched by everything that happened after.
    expect(fvgHandedOutAtBar2.fillPercentage).toBe(0);
    expect(fvgHandedOutAtBar2.state).toBe("FRESH");
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
