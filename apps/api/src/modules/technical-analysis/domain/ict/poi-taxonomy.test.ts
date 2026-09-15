import { describe, expect, it } from "vitest";
import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import type { IctStructureSnapshot, StructureEvent } from "./structure.js";
import { IctZoneLedger } from "./zones.js";

/**
 * The lecture-7 order-block taxonomy.
 *
 * The structure snapshot is stubbed rather than driven through `IctStructureTracker`. The ledger
 * reads only `lastEvent`, `idm`, `lastHL` and `lastLH` off it, and a real tracker would need a
 * confirmed pivot plus a wick-only break to emit a SWEEP -- fixture machinery that would be testing
 * the pivot confirmer, not the classifier under test.
 */

function mk(i: number, o: number, h: number, l: number, c: number): CausalCandle {
  return {
    id: `c-${i}`,
    openTime: new Date(Date.UTC(2026, 0, 1, 9, 15 + i * 5)),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  };
}

const NEUTRAL: IctStructureSnapshot = {
  trend: "NEUTRAL",
  lastHH: null,
  lastHL: null,
  lastLL: null,
  lastLH: null,
  idm: null,
  bosLevel: null,
  chochLevel: null,
  internalVsExternal: "INTERNAL",
  lastEvent: null,
  confirmedPivotCount: 0,
};

function withEvent(type: StructureEvent["type"], direction: "BULLISH" | "BEARISH"): IctStructureSnapshot {
  const pivot = { index: 0, price: 112, type: "HIGH", confirmedAtIndex: 2 } as unknown as ConfirmedPivot;
  return {
    ...NEUTRAL,
    lastEvent: {
      type,
      direction,
      level: 112,
      candleIndex: 2,
      candleTime: new Date(Date.UTC(2026, 0, 1, 9, 25)),
      brokenPivot: pivot,
      isWickOnly: type === "SWEEP",
    },
  };
}

function run(
  candles: readonly CausalCandle[],
  structs: readonly IctStructureSnapshot[],
  invertedBlocksRemainPoi: boolean
) {
  const ledger = new IctZoneLedger(1.5, 0.5, invertedBlocksRemainPoi);
  let snap = ledger.processCandle(candles, 0, structs[0] ?? NEUTRAL);
  for (let i = 1; i < candles.length; i += 1) {
    snap = ledger.processCandle(candles, i, structs[i] ?? NEUTRAL);
  }
  return snap;
}

/** Bullish block at 99-101 (mean threshold 100), created on bar 2. Its body is 25% of the range. */
const CLASSIC_SETUP = [mk(0, 100, 101, 99, 99.5), mk(1, 99.5, 110, 99.4, 109), mk(2, 106, 112, 105, 111)];
/** The same, except the block candle is 84% lower wick. */
const REJECTION_SETUP = [mk(0, 100, 100.5, 96, 99.8), mk(1, 99.8, 110, 99.7, 109), mk(2, 106, 112, 105, 111)];
/** Price returns and closes at 98.5 -- below the 100 mean threshold, so the block failed. */
const FAILURE_BAR = mk(3, 101, 102, 98, 98.5);

describe("order block taxonomy", () => {
  it("labels an ordinary block with an attached gap CLASSIC", () => {
    const snap = run(CLASSIC_SETUP, [], false);
    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].kind).toBe("CLASSIC");
  });

  it("labels a block whose facing wick exceeds half its range REJECTION", () => {
    const snap = run(REJECTION_SETUP, [], false);
    expect(snap.activeObs[0].kind).toBe("REJECTION");
  });

  it("measures only the wick FACING the trade, so a wick on the wrong side is not a rejection", () => {
    // Bearish block: the UPPER wick is what matters. This candle's big wick is the lower one.
    const candles = [mk(0, 100, 100.2, 96, 100.1), mk(1, 100.1, 100.2, 90, 91), mk(2, 89, 95.9, 88, 89.5)];
    const snap = run(candles, [], false);
    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].type).toBe("BEARISH");
    expect(snap.activeObs[0].kind).not.toBe("REJECTION");
  });

  it("labels the last opposing candle after a structure shift RECLAIM", () => {
    const snap = run(CLASSIC_SETUP, [NEUTRAL, NEUTRAL, withEvent("CHOCH", "BULLISH")], false);
    expect(snap.activeObs[0].kind).toBe("RECLAIM");
  });

  it("ranks the measured candle shape above the structural context", () => {
    // Both a rejection candle AND a post-CHoCH block: the shape wins.
    const snap = run(REJECTION_SETUP, [NEUTRAL, NEUTRAL, withEvent("CHOCH", "BULLISH")], false);
    expect(snap.activeObs[0].kind).toBe("REJECTION");
  });

  it("labels a failed block MITIGATION when the swing was never taken", () => {
    const snap = run([...CLASSIC_SETUP, FAILURE_BAR], [], true);
    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].kind).toBe("MITIGATION");
  });

  it("labels a failed block BREAKER when the swing was swept first", () => {
    const structs = [NEUTRAL, NEUTRAL, withEvent("SWEEP", "BULLISH"), NEUTRAL];
    const snap = run([...CLASSIC_SETUP, FAILURE_BAR], structs, true);
    expect(snap.activeObs[0].kind).toBe("BREAKER");
  });

  it("ignores a sweep running the other way", () => {
    const structs = [NEUTRAL, NEUTRAL, withEvent("SWEEP", "BEARISH"), NEUTRAL];
    const snap = run([...CLASSIC_SETUP, FAILURE_BAR], structs, true);
    expect(snap.activeObs[0].kind).toBe("MITIGATION");
  });

  it("counts a sweep performed by the displacement leg that created the block", () => {
    // The sweep lands on the creation bar, which is two bars AFTER the block candle. Keying the
    // window off `createdAtBarIndex` instead of the block candle mislabelled this as MITIGATION.
    const structs = [NEUTRAL, NEUTRAL, withEvent("SWEEP", "BULLISH"), NEUTRAL];
    const snap = run([...CLASSIC_SETUP, FAILURE_BAR], structs, true);
    expect(snap.activeObs[0].kind).toBe("BREAKER");
  });

  it("does not let a sweep predating the block count", () => {
    /*
     * Two inert leading bars, so that "before the block candle" exists at all. Without them the
     * block candle sits at index 0 and a sweep placed at index 0 is ON it, not before it -- which is
     * what the first version of this test actually asserted.
     */
    const lead = [mk(0, 100, 100.3, 99.7, 100), mk(1, 100, 100.3, 99.7, 100)];
    const candles = [...lead, ...CLASSIC_SETUP, mk(5, 101, 102, 98, 98.5)];
    const structs = [withEvent("SWEEP", "BULLISH"), NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL];
    const snap = run(candles, structs, true);
    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].obCandleIndex).toBe(2);
    expect(snap.activeObs[0].kind).toBe("MITIGATION");
  });
});

describe("invertedBlocksRemainPoi", () => {
  const failed = [...CLASSIC_SETUP, FAILURE_BAR];

  it("discards a failed block by default, reproducing the pre-taxonomy behaviour", () => {
    const snap = run(failed, [], false);
    expect(snap.activeObs).toHaveLength(0);
    expect(snap.lastZoneEvent?.event).toBe("INVALIDATED");
  });

  it("does not label a block MITIGATION when it is being discarded", () => {
    /*
     * The label used to be written before the flag was consulted, so a discarded block still carried
     * it -- and since the ledger hands out live objects to snapshots the backtest had already built,
     * bars from BEFORE the failure saw it too. That put 34 BANKNIFTY signals on a mitigation block in
     * a run where mitigation blocks were switched off.
     */
    const ledger = new IctZoneLedger(1.5, 0.5, false);
    const kinds = new Set<string>();
    for (let i = 0; i < failed.length; i += 1) {
      for (const ob of ledger.processCandle(failed, i, NEUTRAL).activeObs) kinds.add(ob.kind);
    }
    expect(kinds.has("MITIGATION")).toBe(false);
    expect(kinds.has("BREAKER")).toBe(false);
  });

  it("re-enters the failed block as a new zone when enabled", () => {
    const snap = run(failed, [], true);
    expect(snap.activeObs).toHaveLength(1);
    expect(snap.activeObs[0].id).toBe("ob-bullish-2-inv");
    expect(snap.lastZoneEvent?.event).toBe("INVERTED");
  });

  it("flips the polarity, so the ordinary type match finds it on the correct side", () => {
    const snap = run(failed, [], true);
    expect(snap.activeObs[0].type).toBe("BEARISH");
  });

  it("keeps the original bounds and dates the new zone to the failure bar", () => {
    const snap = run(failed, [], true);
    const inv = snap.activeObs[0];
    expect(inv.top).toBe(101);
    expect(inv.bottom).toBe(99);
    expect(inv.meanThreshold).toBe(100);
    expect(inv.createdAtBarIndex).toBe(3);
  });

  it("cannot appear in a snapshot taken before the failure", () => {
    // The leak this design exists to prevent: an earlier snapshot must not gain a zone retroactively.
    const ledger = new IctZoneLedger(1.5, 0.5, true);
    ledger.processCandle(failed, 0, NEUTRAL);
    ledger.processCandle(failed, 1, NEUTRAL);
    const atBar2 = ledger.processCandle(failed, 2, NEUTRAL);
    const idsAtBar2 = atBar2.activeObs.map((o) => o.id);
    ledger.processCandle(failed, 3, NEUTRAL);
    expect(atBar2.activeObs.map((o) => o.id)).toEqual(idsAtBar2);
    expect(idsAtBar2).not.toContain("ob-bullish-2-inv");
  });

  it("retires the re-entered zone through the ordinary lifecycle", () => {
    // Bearish now, so a close above its top ends it -- no special-case branch, and not immortal.
    const beyond = mk(4, 99, 103, 98.9, 102.5);
    const snap = run([...failed, beyond], [], true);
    expect(snap.activeObs.some((o) => o.id === "ob-bullish-2-inv")).toBe(false);
  });

  it("does not run the new zone's lifecycle on its own creation bar", () => {
    const snap = run(failed, [], true);
    expect(snap.activeObs[0].state).toBe("FRESH");
  });
});

describe("the ADVANCE gap", () => {
  it("never produces an advance block, because creation requires a gap", () => {
    /*
     * The advance block of lecture 7 is a block with NO fair value gap. Creation here is guarded by
     * `newlyCreatedFvg`, so `attachedFvgId` is always set and the branch is unreachable. The
     * classifier handles it anyway, for when that guard changes; this test records the case as a
     * standing gap rather than a covered one, and will fail the day advance blocks start existing.
     */
    const ledger = new IctZoneLedger(1.5, 0.5, false);
    const candles = [...CLASSIC_SETUP, FAILURE_BAR, mk(4, 98.5, 99, 97, 97.5), mk(5, 97.5, 106, 97.4, 105)];
    const seen = new Set<string>();
    for (let i = 0; i < candles.length; i += 1) {
      for (const ob of ledger.processCandle(candles, i, NEUTRAL).activeObs) seen.add(ob.kind);
    }
    expect(seen.has("ADVANCE")).toBe(false);
    expect(seen.size).toBeGreaterThan(0);
  });
});
