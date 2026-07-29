import { describe, expect, it } from "vitest";
import type {
  SaveTradeIdeaProposalInput,
  StrategyMarketContext,
  StrategyMarketContextRepository,
  StrategyVersionRepository,
  TradeIdeaRepository,
} from "../domain/strategy.js";
import { defaultTrendBreakoutStrategyConfiguration } from "../domain/trend-breakout-strategy.js";
import { GenerateTradeIdeas } from "./generate-trade-ideas.js";

function qualifyingContext(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: new Date("2026-07-24T03:45:00Z"),
      closeTime: new Date("2026-07-25T03:45:00Z"),
      open: 108,
      high: 112,
      low: 107,
      close: 110,
      volume: 1_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 105 } },
      { code: "SMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 104 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 60 } },
      { code: "MACD", algorithmVersion: "ta-v1", parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, values: { macd: 1, signal: 0.5, histogram: 0.5 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 2 } },
      { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { trend: "UP" } },
    ],
    patterns: [{
      code: "BULLISH_ENGULFING",
      algorithmVersion: "candlestick-v1",
      direction: "BULLISH",
      confidence: 0.8,
      contextCandleIds: ["candle-0", "candle-1"],
      details: {},
    }],
    priceActionEvents: [{
      eventCode: "BREAKOUT",
      algorithmVersion: "price-action-v2",
      direction: "BULLISH",
      level: 108,
      confidence: 0.8,
      details: {},
    }],
  };
}

describe("GenerateTradeIdeas", () => {
  it("persists an explainable proposal from latest completed evidence", async () => {
    const saved: SaveTradeIdeaProposalInput[] = [];
    // The double echoes the registration it is asked about, the way the real
    // repository does. A stub that returned one strategy's configuration for every
    // registration would hand each strategy the other's rule set.
    const strategyVersions: StrategyVersionRepository = {
      ensure: async (input) => ({
        id: `strategy-version-${input.strategyKey}`,
        strategyId: `strategy-${input.strategyKey}`,
        strategyKey: input.strategyKey,
        name: input.name,
        description: input.description,
        version: input.version,
        configuration: { ...input.configuration },
        isActive: true,
        isArchived: false,
      }),
    };
    const contexts: StrategyMarketContextRepository = {
      findLatestCompleted: async () => qualifyingContext(),
    };
    const ideas: TradeIdeaRepository = {
      saveProposal: async (input) => {
        saved.push(input);
        return {
          id: "idea-1",
          instrumentId: input.instrumentId,
          strategyVersionId: input.strategyVersionId,
          sourceCandleId: input.sourceCandleId,
          side: input.side,
          status: "PROPOSED",
          entryPrice: input.entryPrice,
          stopLoss: input.stopLoss,
          targetPrice: input.targetPrice,
          riskReward: input.riskReward,
          confidence: input.confidence,
          expiresAt: input.expiresAt,
        };
      },
    };

    const result = await new GenerateTradeIdeas(strategyVersions, contexts, ideas)
      .execute({ instrumentId: "instrument-1", timeframe: "1d" });

    // Every registered strategy is evaluated, so the result is one entry each.
    // No entry may be STRATEGY_FAILED: that would mean a registered strategy
    // cannot parse its own configuration.
    expect(result.map((entry) => entry.skippedReason)).not.toContain("STRATEGY_FAILED");
    expect(result.find((entry) => entry.strategyKey === "trend-breakout")).toEqual({
      strategyVersionId: "strategy-version-trend-breakout",
      strategyKey: "trend-breakout",
      sourceCandleId: "candle-1",
      candidatesGenerated: 1,
      tradeIdeaIds: ["idea-1"],
      skippedReason: null,
    });
    expect(saved[0]).toMatchObject({
      instrumentId: "instrument-1",
      strategyVersionId: "strategy-version-trend-breakout",
      sourceCandleId: "candle-1",
      side: "LONG",
      entryPrice: 110,
      stopLoss: 107,
      targetPrice: 116,
      riskReward: 2,
    });
    expect(saved[0].reasoning).toContain("This is a close-time paper-trade proposal only; a later phase simulates an eligible next-candle fill.");
    expect(saved[0].evidenceItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "INDICATOR", sourceReference: "ATR:ta-v1" }),
      expect.objectContaining({ sourceType: "PATTERN", sourceReference: "BULLISH_ENGULFING:candlestick-v1" }),
      expect.objectContaining({ sourceType: "PRICE_ACTION", sourceReference: "BREAKOUT:price-action-v2" }),
    ]));
  });
});
