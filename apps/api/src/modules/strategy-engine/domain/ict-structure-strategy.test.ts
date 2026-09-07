import { describe, it, expect } from "vitest";
import { IctStructureStrategy, ictStructureStrategyRegistration } from "./ict-structure-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";

function makeContext(ictSnapshot?: IctStateCompositeSnapshot, close = 100): StrategyMarketContext {
  return {
    candle: {
      id: "c-test-1",
      instrumentId: "inst-1",
      timeframe: "5m",
      openTime: new Date("2026-01-06T03:45:00.000Z"),
      closeTime: new Date("2026-01-06T03:50:00.000Z"),
      open: 98,
      high: 101,
      low: 97,
      close,
      volume: 500,
      tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    ictSnapshot,
  };
}

describe("IctStructureStrategy", () => {
  it("emits 0 proposals when ictSnapshot is missing (strict negative gate)", () => {
    const strategy = new IctStructureStrategy();
    const proposals = strategy.evaluate(makeContext(), {});
    expect(proposals).toHaveLength(0);
  });

  it("emits 0 proposals when any pillar is UNKNOWN or incomplete", () => {
    const strategy = new IctStructureStrategy();
    const incompleteSnap: any = {
      coverage: {
        structure: "UNKNOWN", // Chop!
        bias: "COMPLETE",
        zones: "COMPLETE",
        sessionLevels: "COMPLETE",
      },
    };
    const proposals = strategy.evaluate(makeContext(incompleteSnap), {});
    expect(proposals).toHaveLength(0);
  });

  it("emits a valid LONG proposal when all 4 pillars align in discount with POI reaction", () => {
    const strategy = new IctStructureStrategy();
    const alignedSnap: any = {
      coverage: {
        structure: "COMPLETE",
        bias: "COMPLETE",
        zones: "COMPLETE",
        sessionLevels: "COMPLETE",
        liquidity: "COMPLETE",
        htf: "COMPLETE",
      },
      htfBias: "BULLISH",
      bias: {
        bias: "BULLISH",
        dailyTemplate: "OLHC",
        dealingRange: { equilibrium: 105 },
      },
      structure: {
        trend: "BULLISH",
      },
      zones: {
        activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 98, isExtreme: true, isIdmAdjacent: false }],
        activeFvgs: [],
      },
      sessionLevels: {
        levels: { pdh: 120, pdl: 90 },
        lastSweepEvent: null,
      },
      liquidity: {
        alignmentStatus: "ALIGNED_LONG",
        primaryTarget: { kind: "ERL_PDH", price: 120 },
        intermediateTarget: 105,
        invalidationLevel: 90,
      },
    };

    // Close is 98 (Discount < 105)
    const proposals = strategy.evaluate(makeContext(alignedSnap, 98), {});
    expect(proposals).toHaveLength(1);
    const idea = proposals[0];
    expect(idea.side).toBe("LONG");
    expect(idea.entryPrice).toBe(98);
    expect(idea.stopLoss).toBe(90);
    expect(idea.targetPrice).toBe(120);
    expect(idea.riskReward).toBe(2.75); // (120 - 98) / (98 - 90) = 22 / 8 = 2.75
    expect(idea.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("rejects proposal if risk-reward is below threshold", () => {
    const strategy = new IctStructureStrategy();
    const alignedSnap: any = {
      coverage: {
        structure: "COMPLETE",
        bias: "COMPLETE",
        zones: "COMPLETE",
        sessionLevels: "COMPLETE",
        liquidity: "COMPLETE",
        htf: "COMPLETE",
      },
      htfBias: "BULLISH",
      bias: {
        bias: "BULLISH",
        dailyTemplate: "OLHC",
        dealingRange: { equilibrium: 105 },
      },
      structure: {
        trend: "BULLISH",
      },
      zones: {
        activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 98, isExtreme: true, isIdmAdjacent: false }],
        activeFvgs: [],
      },
      sessionLevels: {
        levels: { pdh: 105, pdl: 90 },
        lastSweepEvent: null,
      },
      liquidity: {
        alignmentStatus: "ALIGNED_LONG",
        primaryTarget: { kind: "ERL_PDH", price: 101 }, // Target only 101
        intermediateTarget: 105,
        invalidationLevel: 95, // Stop 95 -> risk = 3, reward = 3 -> R:R = 1.0 < 1.5
      },
    };

    const proposals = strategy.evaluate(makeContext(alignedSnap, 98), { minimumRiskReward: 1.5 });
    expect(proposals).toHaveLength(0);
  });

  // A fully-covered, four-pillar-aligned LONG setup used as the base for the
  // per-pillar negative matrix below. Each matrix case degrades exactly one
  // pillar and asserts the gate fails closed.
  function alignedLongSnap(): any {
    return {
      coverage: {
        structure: "COMPLETE",
        bias: "COMPLETE",
        zones: "COMPLETE",
        sessionLevels: "COMPLETE",
        liquidity: "COMPLETE",
        htf: "COMPLETE",
      },
      htfBias: "BULLISH",
      bias: { bias: "BULLISH", dailyTemplate: "OLHC", dealingRange: { equilibrium: 105 } },
      structure: { trend: "BULLISH" },
      zones: { activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 98, isExtreme: true, isIdmAdjacent: false }], activeFvgs: [] },
      sessionLevels: { levels: { pdh: 120, pdl: 90 }, lastSweepEvent: null },
      liquidity: {
        alignmentStatus: "ALIGNED_LONG",
        primaryTarget: { kind: "ERL_PDH", price: 120 },
        intermediateTarget: 105,
        invalidationLevel: 90,
      },
    };
  }

  describe("negative gate matrix: each degraded pillar fails closed", () => {
    const strategy = new IctStructureStrategy();

    for (const pillar of ["structure", "bias", "zones", "sessionLevels", "liquidity", "htf"] as const) {
      it(`emits 0 proposals when coverage.${pillar} is UNKNOWN`, () => {
        const snap = alignedLongSnap();
        snap.coverage[pillar] = "UNKNOWN";
        expect(strategy.evaluate(makeContext(snap, 98), {})).toHaveLength(0);
      });

      it(`emits 0 proposals when coverage.${pillar} is NOT_COVERED`, () => {
        const snap = alignedLongSnap();
        snap.coverage[pillar] = "NOT_COVERED";
        expect(strategy.evaluate(makeContext(snap, 98), {})).toHaveLength(0);
      });
    }

    it("emits 0 proposals when HTF bias contradicts the local direction", () => {
      const snap = alignedLongSnap();
      snap.htfBias = "BEARISH"; // fractal pillar disagrees
      expect(strategy.evaluate(makeContext(snap, 98), {})).toHaveLength(0);
    });

    it("still emits the LONG proposal at the aligned baseline (matrix control)", () => {
      const snap = alignedLongSnap();
      expect(strategy.evaluate(makeContext(snap, 98), {})).toHaveLength(1);
    });

    it("treats a COMPLETE-but-NEUTRAL bias as no-trade at the gate, not as missing evidence", () => {
      // Coverage is fully COMPLETE (the engine ran on sufficient evidence); the
      // bias value is NEUTRAL (no directional edge). It must pass the coverage
      // gate and be refused for lack of direction — never mapped to UNKNOWN.
      const snap = alignedLongSnap();
      snap.bias.bias = "NEUTRAL";
      snap.structure.trend = "NEUTRAL";
      snap.htfBias = null;
      expect(snap.coverage.bias).toBe("COMPLETE");
      expect(strategy.evaluate(makeContext(snap, 98), {})).toHaveLength(0);
    });
  });
});

/** The aligned-long snapshot the gate tests share, with a zones override for POI cases. */
function alignedLongSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    coverage: {
      structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE",
      sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE",
    },
    htfBias: "BULLISH",
    bias: { bias: "BULLISH", dailyTemplate: "OLHC", dealingRange: { equilibrium: 105 } },
    structure: { trend: "BULLISH", lastHL: { price: 90 } },
    zones: { activeObs: [], activeFvgs: [] },
    sessionLevels: { levels: { pdh: 120, pdl: 90 }, lastSweepEvent: null },
    liquidity: {
      alignmentStatus: "ALIGNED_LONG",
      primaryTarget: { kind: "ERL_PDH", price: 120 },
      intermediateTarget: 105,
      invalidationLevel: 90,
    },
    ...overrides,
  };
}

describe("IctStructureStrategy POI discrimination", () => {
  /*
   * These pin the behaviour that made `requirePoiReaction` free: the old test accepted any zone in
   * state TOUCHED, so it passed every pillar-aligned bar on both indices (`noPoi: 0`).
   */
  it("refuses an order block that was touched but not traded into its mean threshold", () => {
    // Bar low is 97. A mean threshold of 96 was never reached, so the OB is touched at its edge only.
    const snapshot = alignedLongSnapshot({
      zones: {
        activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 96, isExtreme: true, isIdmAdjacent: false }],
        activeFvgs: [],
      },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(0);
  });

  it("refuses a zone facing the wrong way, which used to count as confirmation", () => {
    // A BEARISH order block is evidence against a long. The old check ignored `type` entirely.
    const snapshot = alignedLongSnapshot({
      zones: {
        activeObs: [{ id: "ob-1", type: "BEARISH", state: "TOUCHED", meanThreshold: 98, isExtreme: true, isIdmAdjacent: false }],
        activeFvgs: [],
      },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(0);
  });

  it("accepts a fair value gap only once its consequent encroachment is traded into", () => {
    const shallow = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 96, fillPercentage: 0.1 }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(shallow), {})).toHaveLength(0);

    const deep = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 98, fillPercentage: 0.6 }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(deep), {})).toHaveLength(1);
  });
});
