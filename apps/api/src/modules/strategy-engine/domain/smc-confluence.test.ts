import { describe, expect, it } from "vitest";
import type { ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";
import { applySmcConfluenceToProposal, measureSmcConfluence } from "./smc-confluence.js";

function context(indicators: StrategyMarketContext["indicators"]): StrategyMarketContext {
  return {
    candle: {
      id: "c1", instrumentId: "i1", timeframe: "5m",
      openTime: new Date("2026-08-12T06:30:00Z"), closeTime: new Date("2026-08-12T06:35:00Z"),
      open: 100, high: 103, low: 99, close: 102, volume: 1000, tickSize: 0.05,
    },
    indicators,
    patterns: [],
    priceActionEvents: [],
  };
}

function proposal(side: "LONG" | "SHORT"): ProposedTradeIdea {
  return {
    side,
    entryPrice: 102,
    stopLoss: side === "LONG" ? 100 : 104,
    targetPrice: side === "LONG" ? 106 : 98,
    riskReward: 2,
    confidence: 0.7,
    reasoning: ["Base rules passed."],
    evidence: { strategy: "test" },
    expiresAt: null,
    evidenceItems: [],
  };
}

describe("SMC confluence", () => {
  it("scores corrected bullish evidence symmetrically for both theses", () => {
    const result = measureSmcConfluence(context([
      { code: "BOS", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BULLISH_BOS", level: 101 } },
      { code: "FVG", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BULLISH", top: 101, bottom: 100 } },
    ]));

    expect(result.long.adjustment).toBe(8);
    expect(result.short.adjustment).toBe(-8);
    expect(result.signals).toHaveLength(2);
  });

  it("ignores legacy SMC and non-directional equilibrium context", () => {
    const result = measureSmcConfluence(context([
      { code: "BOS", algorithmVersion: "ta-v1", parameters: {}, values: { type: "BULLISH_BOS", level: 101 } },
      { code: "EQUILIBRIUM_ZONE", algorithmVersion: "smc-v2", parameters: {}, values: { top: 105, bottom: 95, equilibrium: 100 } },
    ]));

    expect(result.signals).toEqual([]);
    expect(result.long.adjustment).toBe(0);
    expect(result.short.adjustment).toBe(0);
  });

  it("bounds stacked observations and appends auditable proposal evidence", () => {
    const market = context([
      { code: "CHOCH", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BEARISH_CHOCH", level: 101 } },
      { code: "BOS", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BEARISH_BOS", level: 101 } },
      { code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BEARISH_SWEEP", level: 103 } },
    ]);

    const adjusted = applySmcConfluenceToProposal(market, proposal("SHORT"));

    expect(adjusted.confidence).toBeCloseTo(0.8);
    expect(adjusted.evidenceItems.at(-1)).toMatchObject({
      sourceReference: "SMC:smc-v2",
      contribution: 0.1,
    });
    expect(adjusted.evidence.smc).toMatchObject({ adjustment: 10, baseConfidence: 0.7 });
  });
});
