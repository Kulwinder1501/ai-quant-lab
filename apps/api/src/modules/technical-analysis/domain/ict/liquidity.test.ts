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
