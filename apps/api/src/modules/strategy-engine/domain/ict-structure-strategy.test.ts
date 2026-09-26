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
    // 90 x 0.9995. The strategy places the stop a 0.05% volatility buffer BEYOND the structural
    // invalidation rather than exactly on it -- a stop resting on the level is hit by the move that
    // merely touches it. This assertion predated the buffer.
    expect(idea.stopLoss).toBeCloseTo(89.955, 3);
    expect(idea.targetPrice).toBe(120);
    // (120 - 98) / (98 - 89.955) = 22 / 8.045. Follows from the volatility buffer above: the stop
    // sits past the invalidation, so risk is slightly larger and the ratio slightly lower than the
    // 2.75 this assertion was written against.
    expect(idea.riskReward).toBeCloseTo(2.734, 2);
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
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 96, fillPercentage: 0.1, isExtreme: true, isIdmAdjacent: false }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(shallow), {})).toHaveLength(0);

    const deep = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 98, fillPercentage: 0.6, isExtreme: true, isIdmAdjacent: false }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(deep), {})).toHaveLength(1);
  });

  /*
   * The fair-value-gap counterpart to the order-block scoping fix above: `FairValueGap` carried no
   * `isIdmAdjacent`/`isExtreme` fields at all until now, so any active gap traded into its CE could
   * supply a live entry regardless of where it sat in the IDM-to-swing range -- on the POI type that
   * supplies the large majority of this strategy's entries.
   */
  it("refuses a fair value gap traded into its CE that is neither IDM-adjacent nor extreme", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 98, fillPercentage: 0.6, isExtreme: false, isIdmAdjacent: false }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(0);
  });

  it("accepts an IDM-adjacent fair value gap even when it is not the swing extreme", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 98, fillPercentage: 0.6, isExtreme: false, isIdmAdjacent: true }] },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(1);
  });

  /*
   * Pins the fix for the gap `ict-implementation-vs-source-doctrine` flagged as "not yet done": the
   * strategy used to take the FIRST order block matching type + mean-threshold reach, with no check
   * that it was one of the (at most) two the doctrine treats as real candidates (the one right after
   * IDM, or the one at the swing extreme). A block that is neither is exactly the "in-between" case
   * lecture 4 declares irrelevant.
   */
  it("refuses an order block traded into its mean threshold that is neither IDM-adjacent nor extreme", () => {
    const snapshot = alignedLongSnapshot({
      zones: {
        activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 98, isExtreme: false, isIdmAdjacent: false }],
        activeFvgs: [],
      },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(0);
  });

  it("accepts an IDM-adjacent order block even when it is not the swing extreme", () => {
    const snapshot = alignedLongSnapshot({
      zones: {
        activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: 98, isExtreme: false, isIdmAdjacent: true }],
        activeFvgs: [],
      },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(1);
  });
});

describe("IctStructureStrategy swing-hierarchy protected level (entry-model arm 4)", () => {
  const validOb = { id: "ob-1", type: "BULLISH" as const, state: "TOUCHED" as const, meanThreshold: 98, isExtreme: true, isIdmAdjacent: false };

  it("is off by default: an approved idea is unaffected even when the protected level is breached", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      // Bullish trend, price 100 (default close): a protected ITL at 105 is already breached.
      swingHierarchy: { nearestIntermediateTermHigh: null, nearestIntermediateTermLow: { price: 105 }, nearestShortTermHigh: null, nearestShortTermLow: null },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(1);
  });

  it("rejects when the arm is on and the protected ITL is already breached", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      swingHierarchy: { nearestIntermediateTermHigh: null, nearestIntermediateTermLow: { price: 105 }, nearestShortTermHigh: null, nearestShortTermLow: null },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireProtectedLevelIntact: true })).toHaveLength(0);
  });

  it("still approves when the arm is on and the protected ITL is intact", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      // ITL at 80, price 100: not breached.
      swingHierarchy: { nearestIntermediateTermHigh: null, nearestIntermediateTermLow: { price: 80 }, nearestShortTermHigh: null, nearestShortTermLow: null },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireProtectedLevelIntact: true })).toHaveLength(1);
  });

  it("never gates on a missing swingHierarchy field (absent evidence, not evidence of a breach)", () => {
    const snapshot = alignedLongSnapshot({ zones: { activeObs: [validOb], activeFvgs: [] } });
    delete snapshot.swingHierarchy;
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireProtectedLevelIntact: true })).toHaveLength(1);
  });
});

describe("IctStructureStrategy CISD confirmation (entry-model arm 5)", () => {
  const validOb = { id: "ob-1", type: "BULLISH" as const, state: "TOUCHED" as const, meanThreshold: 98, isExtreme: true, isIdmAdjacent: false };
  const freshBullishCisd = {
    direction: "BULLISH" as const, triggerLevel: 96, legStartIndex: 10, legEndIndex: 11,
    confirmingCandleIndex: 15, confirmingCandleTime: new Date("2026-01-06T03:40:00.000Z"),
  };

  it("is off by default: an approved idea is unaffected with no CISD evidence at all", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] }, barIndex: 20, cisd: null,
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(1);
  });

  it("rejects when the arm is on and there is no CISD at all", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] }, barIndex: 20, cisd: null,
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireCisdConfirmation: true })).toHaveLength(0);
  });

  it("rejects when the arm is on and the only CISD confirmed points the wrong way", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] }, barIndex: 20,
      cisd: { ...freshBullishCisd, direction: "BEARISH" },
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireCisdConfirmation: true })).toHaveLength(0);
  });

  it("rejects when the arm is on and the matching CISD is older than maxCisdAgeBars", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      barIndex: 30, // 30 - 15 = 15 bars old, past the default maxCisdAgeBars of 10
      cisd: freshBullishCisd,
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { requireCisdConfirmation: true })).toHaveLength(0);
  });

  it("approves when the arm is on and a fresh, direction-matching CISD is present", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      barIndex: 20, // 20 - 15 = 5 bars old, within the default maxCisdAgeBars of 10
      cisd: freshBullishCisd,
    });
    const proposals = new IctStructureStrategy().evaluate(makeContext(snapshot), { requireCisdConfirmation: true });
    expect(proposals).toHaveLength(1);
    const poiConfirmation = proposals[0].evidenceItems?.find((e) => e.sourceReference === "POI_CONFIRMATION");
    expect(poiConfirmation?.details).toMatchObject({ cisdConfirmed: true, cisdAgeBars: 5 });
  });

  it("respects a widened maxCisdAgeBars", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] },
      barIndex: 30, // 15 bars old
      cisd: freshBullishCisd,
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {
      requireCisdConfirmation: true, maxCisdAgeBars: 20,
    })).toHaveLength(1);
  });

  it("never gates on a missing cisd field (absent evidence, not evidence of no confirmation)", () => {
    const snapshot = alignedLongSnapshot({ zones: { activeObs: [validOb], activeFvgs: [] }, barIndex: 20 });
    delete snapshot.cisd;
    // The field is genuinely absent (not null): the loose-equality guard must not throw, and with the
    // arm OFF this must still approve exactly like the other "missing evidence" tests in this file.
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(1);
  });

  it("records cisdConfirmed=false and cisdAgeBars=null as covariates even with the arm off", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] }, barIndex: 20, cisd: null,
    });
    const proposals = new IctStructureStrategy().evaluate(makeContext(snapshot), {});
    expect(proposals).toHaveLength(1);
    const poiConfirmation = proposals[0].evidenceItems?.find((e) => e.sourceReference === "POI_CONFIRMATION");
    expect(poiConfirmation?.details).toMatchObject({ cisdConfirmed: false, cisdAgeBars: null });
  });
});

describe("IctStructureStrategy Balanced Price Range consideration (entry-model arm 6)", () => {
  const validOb = { id: "ob-1", type: "BULLISH" as const, state: "TOUCHED" as const, meanThreshold: 98, isExtreme: true, isIdmAdjacent: false };
  const bullishBpr = { id: "bpr-1", type: "BULLISH" as const, top: 99, bottom: 97, meanThreshold: 98, olderGapId: "a", newerGapId: "b", formedAtBarIndex: 10 };

  it("is off by default: a BPR present with no other POI does not produce a proposal", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [] }, balancedPriceRanges: [bullishBpr],
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), {})).toHaveLength(0);
  });

  it("takes a BPR as the POI when the arm is on and no block or gap is available", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [] }, balancedPriceRanges: [bullishBpr],
    });
    const proposals = new IctStructureStrategy().evaluate(makeContext(snapshot), { considerBpr: true });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidence).toMatchObject({ poiEvidence: expect.stringContaining("Balanced Price Range bpr-1") });
    const poiConfirmation = proposals[0].evidenceItems?.find((e) => e.sourceReference === "POI_CONFIRMATION");
    expect(poiConfirmation?.details).toMatchObject({ poiKind: "BPR" });
  });

  it("refuses a BPR of the wrong direction, same as any other zone", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [], activeFvgs: [] },
      balancedPriceRanges: [{ ...bullishBpr, type: "BEARISH" }],
    });
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { considerBpr: true })).toHaveLength(0);
  });

  it("prefers the existing order block/gap/sweep search over a BPR only by array position, not by exclusion -- a BPR is checked first when the arm is on", () => {
    const snapshot = alignedLongSnapshot({
      zones: { activeObs: [validOb], activeFvgs: [] }, // a valid order block is ALSO available
      balancedPriceRanges: [bullishBpr],
    });
    const proposals = new IctStructureStrategy().evaluate(makeContext(snapshot), { considerBpr: true });
    expect(proposals).toHaveLength(1);
    const poiConfirmation = proposals[0].evidenceItems?.find((e) => e.sourceReference === "POI_CONFIRMATION");
    expect(poiConfirmation?.details).toMatchObject({ poiKind: "BPR" });
  });

  it("never gates on a missing balancedPriceRanges field (absent evidence, not a crash)", () => {
    const snapshot = alignedLongSnapshot({ zones: { activeObs: [validOb], activeFvgs: [] } });
    delete snapshot.balancedPriceRanges;
    expect(new IctStructureStrategy().evaluate(makeContext(snapshot), { considerBpr: true })).toHaveLength(1);
  });
});
