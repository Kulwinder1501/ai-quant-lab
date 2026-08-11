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

/** A completed 1m context that satisfies the momentum-scalp v3 SHORT rule. */
function bearishScalpContext(id: string): StrategyMarketContext {
  return {
    candle: {
      id,
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-07-25T05:00:00Z"),
      closeTime: new Date("2026-07-25T05:01:00Z"),
      open: 101,
      high: 101.5,
      low: 99.5,
      close: 100, // below VWAP by 1 point = 0.5 ATR (inside [0.10, 2.5] window)
      volume: 1_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 98 } },   // fast below slow
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 101 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 35 } },   // in v3 25-45 band
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 101 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 2 } },
    ],
    patterns: [],
    priceActionEvents: [],
  };
}

/** A completed 1m context that satisfies the momentum-scalp v3 LONG rule. */
function bullishScalpContext(id: string): StrategyMarketContext {
  return {
    candle: {
      id,
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-07-25T05:01:00Z"),
      closeTime: new Date("2026-07-25T05:02:00Z"),
      open: 101,
      high: 102.5,
      low: 100.5,
      close: 102, // above VWAP by 1 point = 0.5 ATR (inside [0.10, 2.5] window)
      volume: 1_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 103 } },  // fast above slow
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 101 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 65 } },   // in v3 55-75 band
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 101 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 2 } },
    ],
    patterns: [],
    priceActionEvents: [],
  };
}

function passthroughStrategyVersions(): StrategyVersionRepository {
  return {
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
}

function recordingIdeas(saved: SaveTradeIdeaProposalInput[]): TradeIdeaRepository {
  return {
    saveProposal: async (input) => {
      saved.push(input);
      return {
        id: `idea-${saved.length}`,
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
      listCompletedContexts: async () => [qualifyingContext()],
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

  it("scans a window of candles and surfaces SHORT proposals from bearish bars", async () => {
    const saved: SaveTradeIdeaProposalInput[] = [];
    let ideaCounter = 0;
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
    const window = [bearishScalpContext("candle-bear"), bullishScalpContext("candle-bull")];
    const contexts: StrategyMarketContextRepository = {
      findLatestCompleted: async () => window[window.length - 1],
      // The scan path reads the window; assert it asks for the lookback we passed.
      listCompletedContexts: async (input) => {
        expect(input.limit).toBe(2);
        return window;
      },
    };
    const ideas: TradeIdeaRepository = {
      saveProposal: async (input) => {
        saved.push(input);
        ideaCounter += 1;
        return {
          id: `idea-${ideaCounter}`,
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
      .executeScan({ instrumentId: "instrument-1", timeframe: "1m", lookback: 2 });

    const scalp = result.find((entry) => entry.strategyKey === "momentum-scalp");
    expect(scalp).toBeDefined();
    // The whole point of the scan: a bearish bar in the window becomes a SHORT.
    expect(scalp?.shortIdeas).toBe(1);
    expect(scalp?.longIdeas).toBe(1);
    expect(scalp?.contextsScanned).toBe(2);
    expect(scalp?.skippedReason).toBeNull();

    // No entry may be STRATEGY_FAILED — a registered strategy must parse its own config.
    expect(result.map((entry) => entry.skippedReason)).not.toContain("STRATEGY_FAILED");

    const sides = saved.map((idea) => idea.side);
    expect(sides).toContain("SHORT");
    expect(sides).toContain("LONG");
    // Each proposal is keyed to the bar it came from, not collapsed onto one candle.
    const shortIdea = saved.find((idea) => idea.side === "SHORT");
    expect(shortIdea?.sourceCandleId).toBe("candle-bear");
  });

  // momentum-scalp's RSI bands and ATR-relative VWAP displacement are calibrated
  // for one-minute bars. Run against a daily bar it still emitted proposals, and
  // they reached the Scalp tab stamped "1d" with day-sized stops.
  it("does not run a scalp strategy against a daily candle", async () => {
    const saved: SaveTradeIdeaProposalInput[] = [];
    const contexts: StrategyMarketContextRepository = {
      findLatestCompleted: async () => qualifyingContext(),
      listCompletedContexts: async () => [qualifyingContext()],
    };

    const result = await new GenerateTradeIdeas(passthroughStrategyVersions(), contexts, recordingIdeas(saved))
      .execute({ instrumentId: "instrument-1", timeframe: "1d" });

    expect(result.find((entry) => entry.strategyKey === "momentum-scalp")).toEqual({
      strategyVersionId: null,
      strategyKey: "momentum-scalp",
      sourceCandleId: null,
      candidatesGenerated: 0,
      tradeIdeaIds: [],
      skippedReason: "TIMEFRAME_UNSUPPORTED",
    });
    expect(saved.every((idea) => idea.strategyVersionId === "strategy-version-trend-breakout")).toBe(true);
  });

  it("does not run a swing strategy against a one-minute candle", async () => {
    const saved: SaveTradeIdeaProposalInput[] = [];
    const window = [bearishScalpContext("candle-bear")];
    const contexts: StrategyMarketContextRepository = {
      findLatestCompleted: async () => window[0],
      listCompletedContexts: async () => window,
    };

    const result = await new GenerateTradeIdeas(passthroughStrategyVersions(), contexts, recordingIdeas(saved))
      .executeScan({ instrumentId: "instrument-1", timeframe: "1m", lookback: 1 });

    expect(result.find((entry) => entry.strategyKey === "trend-breakout")?.skippedReason).toBe("TIMEFRAME_UNSUPPORTED");
    expect(saved.every((idea) => idea.strategyVersionId === "strategy-version-momentum-scalp")).toBe(true);
  });
});
