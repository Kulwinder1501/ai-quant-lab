import { describe, expect, it } from "vitest";
import { extractIctStructuralFeatures } from "./feature-extraction.js";
import type { IctStateCompositeSnapshot } from "./config.js";
import type { OrderBlock } from "./zones.js";
import { IctCompositeEngine } from "./composite-engine.js";
import type { CausalCandle } from "./causal-pivot.js";

function makeOb(overrides: Partial<OrderBlock> & Pick<OrderBlock, "id" | "type" | "meanThreshold">): OrderBlock {
  return {
    top: overrides.meanThreshold + 5,
    bottom: overrides.meanThreshold - 5,
    createdAtBarIndex: 0,
    createdAtBarTime: new Date(),
    obCandleIndex: 0,
    displacementCandleIndex: 1,
    attachedFvgId: null,
    isExtreme: false,
    isIdmAdjacent: false,
    kind: "CLASSIC",
    state: "FRESH",
    ...overrides,
  };
}

// Minimal fully-typed fixture: only the fields `extractIctStructuralFeatures` reads are varied per
// test, everything else is a stable, otherwise-inert value -- same convention as liquidity.test.ts's
// hand-built IctStructureSnapshot/IctZoneSnapshot fixtures.
function makeSnapshot(overrides: {
  readonly htfBias?: IctStateCompositeSnapshot["htfBias"];
  readonly dealingRange?: IctStateCompositeSnapshot["bias"]["dealingRange"];
  readonly activeObs?: readonly OrderBlock[];
  readonly bosLevel?: number | null;
  readonly chochLevel?: number | null;
}): IctStateCompositeSnapshot {
  return {
    engineVersion: "ict-state-v2",
    configHash: "x".repeat(64),
    barIndex: 0,
    barTime: new Date(),
    structure: {
      trend: "NEUTRAL",
      lastHH: null,
      lastHL: null,
      lastLL: null,
      lastLH: null,
      idm: null,
      bosLevel: overrides.bosLevel ?? null,
      chochLevel: overrides.chochLevel ?? null,
      internalVsExternal: "EXTERNAL",
      lastEvent: null,
      confirmedPivotCount: 0,
    },
    zones: {
      activeFvgs: [],
      activeObs: overrides.activeObs ?? [],
      lastZoneEvent: null,
    },
    sessionLevels: {
      levels: null,
      lastSweepEvent: null,
      currentSessionHigh: 0,
      currentSessionLow: 0,
      currentSessionOpen: 0,
      currentSessionDate: "2026-01-06",
    },
    bias: {
      bias: "NEUTRAL",
      dailyTemplate: "UNKNOWN",
      dealingRange: overrides.dealingRange ?? null,
      reasons: [],
    },
    liquidity: {
      erlPoolCount: 0,
      irlPoolCount: 0,
      primaryTarget: null,
      intermediateTarget: null,
      invalidationLevel: null,
      alignmentStatus: "BLOCKED_MISSING_PILLAR",
      rationale: "",
    },
    htfBias: overrides.htfBias ?? null,
    coverage: {
      structure: "UNKNOWN",
      zones: "COMPLETE",
      sessionLevels: "NOT_COVERED",
      bias: "UNKNOWN",
      liquidity: "NOT_COVERED",
      htf: "NOT_COVERED",
    },
  };
}

describe("extractIctStructuralFeatures", () => {
  it("passes the HTF bias straight through, including null", () => {
    expect(extractIctStructuralFeatures(makeSnapshot({ htfBias: "BULLISH" }), 100).htfBias).toBe("BULLISH");
    expect(extractIctStructuralFeatures(makeSnapshot({}), 100).htfBias).toBeNull();
  });

  it("reports UNKNOWN premium/discount when no dealing range has formed", () => {
    const features = extractIctStructuralFeatures(makeSnapshot({ dealingRange: null }), 100);
    expect(features.premiumDiscountZone).toBe("UNKNOWN");
  });

  it("classifies premium vs discount from the dealing range's own predicates", () => {
    const dealingRange = {
      rangeHigh: 120,
      rangeLow: 80,
      equilibrium: 100,
      isPremium: (p: number) => p >= 100,
      isDiscount: (p: number) => p < 100,
    };
    expect(extractIctStructuralFeatures(makeSnapshot({ dealingRange }), 105).premiumDiscountZone).toBe("PREMIUM");
    expect(extractIctStructuralFeatures(makeSnapshot({ dealingRange }), 95).premiumDiscountZone).toBe("DISCOUNT");
  });

  it("finds the nearest doctrinally-valid active order block by distance to its mean threshold, unsigned", () => {
    const near = makeOb({ id: "ob-near", type: "BULLISH", meanThreshold: 98, isExtreme: true });
    const far = makeOb({ id: "ob-far", type: "BEARISH", meanThreshold: 130, isIdmAdjacent: true });
    const features = extractIctStructuralFeatures(makeSnapshot({ activeObs: [far, near] }), 100);
    expect(features.distanceToNearestOrderBlock).toBe(2); // |100 - 98|
    expect(features.nearestOrderBlockSide).toBe("BULLISH");
  });

  it("ignores an order block that is neither IDM-adjacent nor extreme, even if it is nearer to price", () => {
    // Per lecture 4: order blocks "in between" the IDM-adjacent one and the extreme one are
    // explicitly not real candidates at all -- see isDoctrinallyValidOrderBlockCandidate in zones.ts.
    const inBetween = makeOb({ id: "ob-mid", type: "BULLISH", meanThreshold: 99 }); // nearest to price, but not valid
    const valid = makeOb({ id: "ob-valid", type: "BULLISH", meanThreshold: 90, isExtreme: true });
    const features = extractIctStructuralFeatures(makeSnapshot({ activeObs: [inBetween, valid] }), 100);
    expect(features.distanceToNearestOrderBlock).toBe(10); // |100 - 90|, not |100 - 99|
  });

  it("returns null distance/side when no order block is active", () => {
    const features = extractIctStructuralFeatures(makeSnapshot({ activeObs: [] }), 100);
    expect(features.distanceToNearestOrderBlock).toBeNull();
    expect(features.nearestOrderBlockSide).toBeNull();
  });

  it("reports BOS/CHoCH presence and signed distance independently", () => {
    const features = extractIctStructuralFeatures(makeSnapshot({ bosLevel: 110, chochLevel: null }), 100);
    expect(features.hasBosLevel).toBe(true);
    expect(features.distanceToBosLevel).toBe(-10); // 100 - 110
    expect(features.hasChochLevel).toBe(false);
    expect(features.distanceToChochLevel).toBeNull();
  });

  it("leaves refinedOrderBlock null when no HTF snapshot is supplied", () => {
    const features = extractIctStructuralFeatures(makeSnapshot({ activeObs: [] }), 100);
    expect(features.refinedOrderBlock).toBeNull();
  });

  it("leaves refinedOrderBlock null when an HTF snapshot is supplied but has no active order block", () => {
    const htfSnapshot = makeSnapshot({ activeObs: [] });
    const ltfSnapshot = makeSnapshot({ activeObs: [] });
    expect(extractIctStructuralFeatures(ltfSnapshot, 100, htfSnapshot).refinedOrderBlock).toBeNull();
  });

  it("computes a real cross-timeframe refinement when both HTF and LTF order blocks are supplied", () => {
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", meanThreshold: 100, top: 105, bottom: 95, isExtreme: true }); // range 10
    const ltfOb = makeOb({ id: "ltf-1", type: "BULLISH", meanThreshold: 99, top: 101, bottom: 97 }); // range 4, nested
    const htfSnapshot = makeSnapshot({ activeObs: [htfOb] });
    const ltfSnapshot = makeSnapshot({ activeObs: [ltfOb] });

    const features = extractIctStructuralFeatures(ltfSnapshot, 100, htfSnapshot);
    expect(features.refinedOrderBlock).not.toBeNull();
    expect(features.refinedOrderBlock!.htfOrderBlockSide).toBe("BULLISH");
    expect(features.refinedOrderBlock!.refinedOrderBlockDistance).toBe(1); // |100 - 99|
    expect(features.refinedOrderBlock!.stopCompressionRatio).toBeCloseTo(4 / 10, 10);
  });

  it("is a pure function of one snapshot: identical input twice gives identical output", () => {
    const snapshot = makeSnapshot({ htfBias: "BEARISH", bosLevel: 50, activeObs: [makeOb({ id: "a", type: "BULLISH", meanThreshold: 90 })] });
    expect(extractIctStructuralFeatures(snapshot, 88)).toEqual(extractIctStructuralFeatures(snapshot, 88));
  });

  it("wires together against a real engine snapshot, not just hand-built fixtures", () => {
    const engine = new IctCompositeEngine();
    const candles: CausalCandle[] = [
      { id: "c0", openTime: new Date(Date.UTC(2026, 0, 5, 3, 45)), open: 100, high: 100, low: 90, close: 98 },
      { id: "c1", openTime: new Date(Date.UTC(2026, 0, 5, 3, 50)), open: 98, high: 122, low: 97, close: 120 },
      { id: "c2", openTime: new Date(Date.UTC(2026, 0, 5, 3, 55)), open: 115, high: 125, low: 105, close: 123 },
    ].map((c) => ({ ...c, volume: 100 }));

    let snap!: IctStateCompositeSnapshot;
    for (let i = 0; i < candles.length; i++) {
      snap = engine.processCandle(candles, i, "BULLISH");
    }
    const features = extractIctStructuralFeatures(snap, candles[candles.length - 1].close);
    // No assertion on exact structural values here -- this test only proves the extractor accepts a
    // real IctStateCompositeSnapshot end to end and returns a well-formed feature record.
    expect(features.htfBias).toBe("BULLISH");
    expect(["PREMIUM", "DISCOUNT", "UNKNOWN"]).toContain(features.premiumDiscountZone);
  });
});
