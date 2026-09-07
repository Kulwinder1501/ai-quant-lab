import { describe, it, expect } from "vitest";
import { IctLiquidityResolver } from "./liquidity.js";
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
    return {
      index,
      time: new Date(),
      price,
      type,
      confirmedAtIndex: index + 2,
      confirmedAtTime: new Date(),
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
      confirmedPivots: [],
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
      confirmedPivots: [],
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
      confirmedPivots: [],
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
  const pivot = (index: number, price: number, type: "HIGH" | "LOW") => ({
    index, time: new Date(), price, type, confirmedAtIndex: index + 2, confirmedAtTime: new Date(),
  });
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
    internalVsExternal: "EXTERNAL", lastEvent: null, confirmedPivots: [],
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
