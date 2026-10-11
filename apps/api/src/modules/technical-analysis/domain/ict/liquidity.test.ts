import { describe, it, expect } from "vitest";
import { IctLiquidityResolver, buildIctLiquidityPools } from "./liquidity.js";
import type { IctStructureSnapshot } from "./structure.js";
import type { IctZoneSnapshot } from "./zones.js";
import type { SessionLevelsSnapshot } from "./session-levels.js";
import type { IctBiasSnapshot } from "./bias.js";

describe("IctLiquidityResolver", () => {
  const dummySessionLevels: SessionLevelsSnapshot = {
    levels: {
      sessionDate: "2026-01-06",
      priorSessionDate: "2026-01-05",
      pdh: 120,
      pdl: 90,
      pdc: 100,
      pdo: 95,
      eq: 105,
    },
    lastSweepEvent: null,
    currentSessionHigh: 108,
    currentSessionLow: 92,
    currentSessionOpen: 96,
    currentSessionDate: "2026-01-06",
  };

  const dummyZones: IctZoneSnapshot = {
    activeFvgs: [],
    activeObs: [],
    lastZoneEvent: null,
  };

  function makePivot(index: number, price: number, type: "HIGH" | "LOW") {
    const confirmedAtTime = new Date();
    return {
      index,
      time: new Date(),
      price,
      type,
      confirmedAtIndex: index + 2,
      confirmedAtTime,
      availableAt: confirmedAtTime.getTime(),
    };
  }

  it("blocks long entries when price is in Premium (>= EQ)", () => {
    const resolver = new IctLiquidityResolver();
    const biasSnap: IctBiasSnapshot = {
      bias: "BULLISH",
      dailyTemplate: "OLHC",
      dealingRange: {
        rangeHigh: 120,
        rangeLow: 90,
        equilibrium: 105,
        isPremium: (p) => p >= 105,
        isDiscount: (p) => p < 105,
      },
      reasons: ["Bullish bias"],
    };

    const structSnap: IctStructureSnapshot = {
      trend: "BULLISH",
      lastHH: makePivot(10, 120, "HIGH"),
      lastHL: makePivot(5, 90, "LOW"),
      lastLH: null,
      lastLL: null,
      idm: null,
      bosLevel: null,
      chochLevel: null,
      internalVsExternal: "EXTERNAL",
      lastEvent: null,
      confirmedPivotCount: 0,
    };

    // Current price is 110 (Premium >= 105)
    const snap = resolver.resolve(110, biasSnap, structSnap, dummyZones, dummySessionLevels);
    expect(snap.alignmentStatus).toBe("BLOCKED_PREMIUM_LONG");
    expect(snap.primaryTarget).toBeNull();
  });

  it("approves long entry when price is in Discount (< EQ) and targets unmitigated PDH", () => {
    const resolver = new IctLiquidityResolver();
    const biasSnap: IctBiasSnapshot = {
      bias: "BULLISH",
      dailyTemplate: "OLHC",
      dealingRange: {
        rangeHigh: 120,
        rangeLow: 90,
        equilibrium: 105,
        isPremium: (p) => p >= 105,
        isDiscount: (p) => p < 105,
      },
      reasons: ["Bullish bias"],
    };

    const structSnap: IctStructureSnapshot = {
      trend: "BULLISH",
      lastHH: makePivot(10, 120, "HIGH"),
      lastHL: makePivot(5, 90, "LOW"),
      lastLH: null,
      lastLL: null,
      idm: null,
      bosLevel: null,
      chochLevel: null,
      internalVsExternal: "EXTERNAL",
      lastEvent: null,
      confirmedPivotCount: 0,
    };

    // Current price is 98 (Discount < 105)
    const snap = resolver.resolve(98, biasSnap, structSnap, dummyZones, dummySessionLevels);
    expect(snap.alignmentStatus).toBe("ALIGNED_LONG");
    expect(snap.primaryTarget).not.toBeNull();
    expect(snap.primaryTarget?.price).toBe(120);
    expect(snap.intermediateTarget).toBe(105);
    expect(snap.invalidationLevel).toBe(90);
  });

  it("blocks execution if bias and structure trend disagree", () => {
    const resolver = new IctLiquidityResolver();
    const biasSnap: IctBiasSnapshot = {
      bias: "BULLISH",
      dailyTemplate: "OLHC",
      dealingRange: {
        rangeHigh: 120,
        rangeLow: 90,
        equilibrium: 105,
        isPremium: (p) => p >= 105,
        isDiscount: (p) => p < 105,
      },
      reasons: ["Bullish bias"],
    };

    const structSnap: IctStructureSnapshot = {
      trend: "BEARISH", // Disagrees!
      lastHH: null,
      lastHL: null,
      lastLH: makePivot(8, 115, "HIGH"),
      lastLL: makePivot(12, 88, "LOW"),
      idm: null,
      bosLevel: null,
      chochLevel: null,
      internalVsExternal: "EXTERNAL",
      lastEvent: null,
      confirmedPivotCount: 0,
    };

    const snap = resolver.resolve(98, biasSnap, structSnap, dummyZones, dummySessionLevels);
    expect(snap.alignmentStatus).toBe("BLOCKED_BIAS_STRUCTURE_DISAGREEMENT");
  });
});

describe("liquidity objective selection", () => {
  /*
   * The pre-existing bullish test above passes under BOTH the old and new rule: its fixture puts
   * pdh and lastHH at the same price (120), so there is only one candidate and the test cannot tell
   * "nearest" from "farthest". That is why the defect survived it.
   */
  const pivot = (index: number, price: number, type: "HIGH" | "LOW") => {
    const confirmedAtTime = new Date();
    return {
      index, time: new Date(), price, type, confirmedAtIndex: index + 2, confirmedAtTime,
      availableAt: confirmedAtTime.getTime(),
    };
  };
  const zones: IctZoneSnapshot = { activeFvgs: [], activeObs: [], lastZoneEvent: null };
  const bullBias = (equilibrium: number): IctBiasSnapshot => ({
    bias: "BULLISH",
    dailyTemplate: "OLHC",
    dealingRange: {
      rangeHigh: 120, rangeLow: 90, equilibrium,
      isPremium: (price: number) => price >= equilibrium,
      isDiscount: (price: number) => price < equilibrium,
    },
    reasons: ["Bullish bias"],
  });
  const session = (pdh: number, sessionHigh: number): SessionLevelsSnapshot => ({
    levels: { sessionDate: "2026-01-06", priorSessionDate: "2026-01-05", pdh, pdl: 90, pdc: 100, pdo: 95, eq: 105 },
    lastSweepEvent: null,
    currentSessionHigh: sessionHigh,
    currentSessionLow: 92,
    currentSessionOpen: 96,
    currentSessionDate: "2026-01-06",
  });
  const struct = (lastHH: number, lastHL: number): IctStructureSnapshot => ({
    trend: "BULLISH",
    lastHH: pivot(10, lastHH, "HIGH"),
    lastHL: pivot(5, lastHL, "LOW"),
    lastLH: null, lastLL: null, idm: null, bosLevel: null, chochLevel: null,
    internalVsExternal: "EXTERNAL", lastEvent: null, confirmedPivotCount: 0,
  });

  it("takes the farthest ERL beyond equilibrium, not the nearest pool above price", () => {
    // Two unmitigated pools above price 98: pdh at 108 and the swing high at 120, both beyond EQ 105.
    const snap = new IctLiquidityResolver()
      .resolve(98, bullBias(105), struct(120, 90), zones, session(108, 100));

    expect(snap.alignmentStatus).toBe("ALIGNED_LONG");
    // The old rule returned 108. 120 is the external objective the dealing range is drawn toward.
    expect(snap.primaryTarget?.price).toBe(120);
    // The invariant the old rule broke on 80% of live bars: primary lies beyond intermediate.
    expect(snap.primaryTarget!.price).toBeGreaterThan(snap.intermediateTarget!);
  });

  it("refuses when every pool sits inside the range rather than offering one short of equilibrium", () => {
    // pdh 100 and swing high 102 are above price 98 but both BELOW equilibrium 105.
    const snap = new IctLiquidityResolver()
      .resolve(98, bullBias(105), struct(102, 95), zones, session(100, 99));

    // No external objective exists, so coverage.liquidity fails upstream and the bar yields nothing.
    // The old rule would have targeted 100 -- inside the range, and nearer than the intermediate.
    expect(snap.primaryTarget).toBeNull();
  });
});

describe("intermediate target: internal-range waypoint", () => {
  /*
   * `intermediateTarget` used to be the dealing-range equilibrium unconditionally, even though
   * `irlPools` (FVGs/OBs) were already computed a few lines above it and simply never read for this
   * purpose -- decorative, not a bug that changed any gate, but the "internal vs external liquidity"
   * distinction this resolver computes was fictional for target selection. These pin the fix: a real
   * IRL pool between price and the external objective is now reported, and the equilibrium fallback
   * only fires when none exists (the pre-existing tests above, whose fixtures carry no zones, cover
   * that fallback already).
   */
  const pivot = (index: number, price: number, type: "HIGH" | "LOW") => {
    const confirmedAtTime = new Date();
    return {
      index, time: new Date(), price, type, confirmedAtIndex: index + 2, confirmedAtTime,
      availableAt: confirmedAtTime.getTime(),
    };
  };
  const bullBias = (equilibrium: number): IctBiasSnapshot => ({
    bias: "BULLISH",
    dailyTemplate: "OLHC",
    dealingRange: {
      rangeHigh: 120, rangeLow: 90, equilibrium,
      isPremium: (price: number) => price >= equilibrium,
      isDiscount: (price: number) => price < equilibrium,
    },
    reasons: ["Bullish bias"],
  });
  const session = (pdh: number, sessionHigh: number): SessionLevelsSnapshot => ({
    levels: { sessionDate: "2026-01-06", priorSessionDate: "2026-01-05", pdh, pdl: 90, pdc: 100, pdo: 95, eq: 105 },
    lastSweepEvent: null,
    currentSessionHigh: sessionHigh,
    currentSessionLow: 92,
    currentSessionOpen: 96,
    currentSessionDate: "2026-01-06",
  });
  const struct = (lastHH: number, lastHL: number): IctStructureSnapshot => ({
    trend: "BULLISH",
    lastHH: pivot(10, lastHH, "HIGH"),
    lastHL: pivot(5, lastHL, "LOW"),
    lastLH: null, lastLL: null, idm: null, bosLevel: null, chochLevel: null,
    internalVsExternal: "EXTERNAL", lastEvent: null, confirmedPivotCount: 0,
  });

  it("reports the nearest unmitigated FVG between price and the external target, not equilibrium", () => {
    const fvg1BarTime = new Date();
    const zonesWithFvg: IctZoneSnapshot = {
      activeFvgs: [{
        id: "fvg-1", type: "BULLISH", top: 103, bottom: 101, midpoint: 102,
        createdAtBarIndex: 1, createdAtBarTime: fvg1BarTime, candle1Index: 0, candle3Index: 1,
        // Mirrors zones.ts's own FVG construction: confirmedAt/availableAt default to the gap's
        // own creation instant (candle3's open time).
        confirmedAt: fvg1BarTime.getTime(), availableAt: fvg1BarTime.getTime(),
        fillPercentage: 0, state: "FRESH", invertedAtBarIndex: null, isExtreme: false, isIdmAdjacent: false,
      }],
      activeObs: [],
      lastZoneEvent: null,
    };
    // Price 98, equilibrium 105, external objective 120 (swing high). FVG midpoint 102 sits between them.
    const snap = new IctLiquidityResolver().resolve(98, bullBias(105), struct(120, 90), zonesWithFvg, session(108, 100));
    expect(snap.primaryTarget?.price).toBe(120);
    expect(snap.intermediateTarget).toBe(102);
  });

  it("falls back to equilibrium when no IRL pool sits between price and the external target", () => {
    const fvg1BarTime = new Date();
    const zonesWithFarFvg: IctZoneSnapshot = {
      activeFvgs: [{
        id: "fvg-1", type: "BULLISH", top: 130, bottom: 128, midpoint: 129, // beyond the target itself
        createdAtBarIndex: 1, createdAtBarTime: fvg1BarTime, candle1Index: 0, candle3Index: 1,
        confirmedAt: fvg1BarTime.getTime(), availableAt: fvg1BarTime.getTime(),
        fillPercentage: 0, state: "FRESH", invertedAtBarIndex: null, isExtreme: false, isIdmAdjacent: false,
      }],
      activeObs: [],
      lastZoneEvent: null,
    };
    const snap = new IctLiquidityResolver().resolve(98, bullBias(105), struct(120, 90), zonesWithFarFvg, session(108, 100));
    expect(snap.intermediateTarget).toBe(105);
  });

  it("ignores a mitigated (already-consumed) IRL pool in the path", () => {
    const fvg1BarTime = new Date();
    const zonesWithConsumedFvg: IctZoneSnapshot = {
      activeFvgs: [{
        id: "fvg-1", type: "BULLISH", top: 103, bottom: 101, midpoint: 102,
        createdAtBarIndex: 1, createdAtBarTime: fvg1BarTime, candle1Index: 0, candle3Index: 1,
        confirmedAt: fvg1BarTime.getTime(), availableAt: fvg1BarTime.getTime(),
        fillPercentage: 1, state: "CONSUMED", invertedAtBarIndex: null, isExtreme: false, isIdmAdjacent: false,
      }],
      activeObs: [],
      lastZoneEvent: null,
    };
    const snap = new IctLiquidityResolver().resolve(98, bullBias(105), struct(120, 90), zonesWithConsumedFvg, session(108, 100));
    expect(snap.intermediateTarget).toBe(105);
  });
});

describe("swept swing / EQH / EQL pools stay mitigated after price retreats", () => {
  /*
   * Before this fix `isMitigated` for swing/EQH/EQL used only the CURRENT price, so a level that
   * price had run through and left behind became a live target again (PDH/PDL already used the
   * session path). The resolver now tracks the high/low since each pool was first confirmed.
   */
  const pivot = (index: number, price: number, type: "HIGH" | "LOW") => {
    const confirmedAtTime = new Date();
    return {
      index, time: new Date(), price, type, confirmedAtIndex: index + 2, confirmedAtTime,
      availableAt: confirmedAtTime.getTime(),
    };
  };
  const zones: IctZoneSnapshot = { activeFvgs: [], activeObs: [], lastZoneEvent: null };
  const bullBias: IctBiasSnapshot = {
    bias: "BULLISH",
    dailyTemplate: "OLHC",
    dealingRange: {
      rangeHigh: 125, rangeLow: 90, equilibrium: 105,
      isPremium: (price: number) => price >= 105,
      isDiscount: (price: number) => price < 105,
    },
    reasons: ["Bullish bias"],
  };
  const session: SessionLevelsSnapshot = {
    levels: { sessionDate: "2026-01-06", priorSessionDate: "2026-01-05", pdh: 108, pdl: 90, pdc: 100, pdo: 95, eq: 105 },
    lastSweepEvent: null,
    currentSessionHigh: 100,
    currentSessionLow: 92,
    currentSessionOpen: 96,
    currentSessionDate: "2026-01-06",
  };
  const struct: IctStructureSnapshot = {
    trend: "BULLISH",
    lastHH: pivot(10, 120, "HIGH"),
    lastHL: pivot(5, 90, "LOW"),
    lastLH: null, lastLL: null, idm: null, bosLevel: null, chochLevel: null,
    internalVsExternal: "EXTERNAL", lastEvent: null, confirmedPivotCount: 0,
  };

  it("does not revive a swing high that a later bar traded through once price falls back below it", () => {
    const resolver = new IctLiquidityResolver();
    // Bar 1: price 98, swing high 120 is the external objective.
    expect(resolver.resolve(98, bullBias, struct, zones, session).primaryTarget?.price).toBe(120);
    // Bar 2: price runs through 120 (premium -> entries blocked, but the path is recorded).
    expect(resolver.resolve(121, bullBias, struct, zones, session).alignmentStatus).toBe("BLOCKED_PREMIUM_LONG");
    // Bar 3: price retreats to 98. The old current-price test said 120 was live again.
    const after = resolver.resolve(98, bullBias, struct, zones, session);
    expect(after.alignmentStatus).toBe("ALIGNED_LONG");
    expect(after.primaryTarget?.price).toBe(108); // falls back to the still-unswept PDH
  });

  it("counts an intrabar sweep (bar high) even when the bar closes back below the level", () => {
    const resolver = new IctLiquidityResolver();
    const snap = resolver.resolve(98, bullBias, struct, zones, session, [], { high: 121, low: 97 });
    expect(snap.primaryTarget?.price).toBe(108);
  });

  it("leaves an untouched swing high live across bars", () => {
    const resolver = new IctLiquidityResolver();
    resolver.resolve(98, bullBias, struct, zones, session);
    resolver.resolve(110, bullBias, struct, zones, session);
    expect(resolver.resolve(99, bullBias, struct, zones, session).primaryTarget?.price).toBe(120);
  });

  it("drops path state for pools that disappear (no unbounded growth)", () => {
    const resolver = new IctLiquidityResolver();
    resolver.resolve(98, bullBias, struct, zones, session);
    const noStructure: IctStructureSnapshot = { ...struct, lastHH: null, lastHL: null };
    resolver.resolve(98, bullBias, noStructure, zones, session);
    expect((resolver as unknown as { poolPath: Map<string, unknown> }).poolPath.size).toBe(0);
  });

  it("buildIctLiquidityPools: swing low swept on the path stays mitigated; legacy callers keep the spot test", () => {
    const lowStruct: IctStructureSnapshot = { ...struct, lastHH: null, lastHL: pivot(5, 95, "LOW") };
    const withPath = buildIctLiquidityPools(100, lowStruct, zones, session, [], () => ({ high: 101, low: 94 }));
    expect(withPath.erlPools.find((p) => p.kind === "ERL_SWING_LOW")?.isMitigated).toBe(true);
    const spotOnly = buildIctLiquidityPools(100, lowStruct, zones, session);
    expect(spotOnly.erlPools.find((p) => p.kind === "ERL_SWING_LOW")?.isMitigated).toBe(false);
  });

  it("applies the same path rule to equal highs / equal lows", () => {
    const pivots = [pivot(1, 119.97, "HIGH"), pivot(4, 120, "HIGH")].map((p) => ({ ...p, type: "HIGH" as const }));
    const noSwing: IctStructureSnapshot = { ...struct, lastHH: null, lastHL: null };
    const swept = buildIctLiquidityPools(100, noSwing, zones, session, pivots, () => ({ high: 121, low: 99 }));
    expect(swept.erlPools.find((p) => p.kind === "ERL_EQH")?.isMitigated).toBe(true);
    const live = buildIctLiquidityPools(100, noSwing, zones, session, pivots, () => ({ high: 110, low: 99 }));
    expect(live.erlPools.find((p) => p.kind === "ERL_EQH")?.isMitigated).toBe(false);
  });
});
