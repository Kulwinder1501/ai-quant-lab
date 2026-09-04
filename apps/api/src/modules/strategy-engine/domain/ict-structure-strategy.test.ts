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
      },
      bias: {
        bias: "BULLISH",
        dailyTemplate: "OLHC",
        dealingRange: { equilibrium: 105 },
      },
      structure: {
        trend: "BULLISH",
      },
      zones: {
        activeObs: [{ id: "ob-1", state: "TOUCHED" }],
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
      },
      bias: {
        bias: "BULLISH",
        dailyTemplate: "OLHC",
        dealingRange: { equilibrium: 105 },
      },
      structure: {
        trend: "BULLISH",
      },
      zones: {
        activeObs: [{ id: "ob-1", state: "TOUCHED" }],
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
});
