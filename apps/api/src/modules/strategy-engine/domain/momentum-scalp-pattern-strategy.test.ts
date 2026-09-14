import { describe, expect, it } from "vitest";
import {
  defaultMomentumScalpPatternStrategyConfiguration,
  MomentumScalpPatternStrategy,
  MomentumScalpPatternStrategyV2,
  computeConfigurationHash,
} from "./momentum-scalp-pattern-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";

const CONFIGURATION = { ...defaultMomentumScalpPatternStrategyConfiguration } as Record<string, unknown>;

function createContext(options: {
  close?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  atr?: number;
  vwap?: number;
  supertrendTrend?: string;
  supertrendValue?: number;
  emaFast?: number;
  patterns?: StrategyMarketContext["patterns"];
  priceActionEvents?: StrategyMarketContext["priceActionEvents"];
} = {}): StrategyMarketContext {
  const close = options.close ?? 24_000;
  const open = options.open ?? 23_980;
  const high = options.high ?? 24_020;
  const low = options.low ?? 23_970;
  const volume = options.volume ?? 5000;

  const snapshot = (code: string, values: Record<string, string | number | boolean | null>) => ({
    code: code as any,
    algorithmVersion: "ta-v1",
    parameters: {},
    values: values as any,
  });

  return {
    candle: {
      id: "candle-1",
      instrumentId: "inst-1",
      timeframe: "5m",
      openTime: new Date("2026-08-11T04:00:00.000Z"),
      closeTime: new Date("2026-08-11T04:05:00.000Z"),
      open,
      high,
      low,
      close,
      volume,
      tickSize: 0.05,
    },
    indicators: [
      snapshot("ATR", { value: options.atr ?? 20 }),
      snapshot("VWAP", { value: options.vwap ?? 23_990 }),
      snapshot("SUPERTREND", {
        trend: options.supertrendTrend ?? "UP",
        value: options.supertrendValue ?? 23_950,
      }),
      snapshot("EMA", { value: options.emaFast ?? 23_985 }),
    ],
    patterns: options.patterns ?? [],
    priceActionEvents: options.priceActionEvents ?? [],
  };
}

describe("MomentumScalpPatternStrategy", () => {
  const strategy = new MomentumScalpPatternStrategy();

  it("generates a LONG trade idea when context score clears threshold with confirming bullish pattern", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "UP",
      vwap: 23_990, // price above vwap (+2)
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "SUPPORT",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 23_990, // near support (distance 10 / 20 = 0.5 ATR <= 1.5 ATR -> +2)
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(1);
    const idea = ideas[0];
    expect(idea.side).toBe("LONG");
    expect(idea.entryPrice).toBe(24_000);
    expect(idea.stopLoss).toBe(23_980); // 24000 - 20 * 1.0 = 23980
    expect(idea.targetPrice).toBe(24_030); // 24000 + 20 * 1.5 = 24030
    expect(idea.riskReward).toBe(1.5);
    expect(idea.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("generates a SHORT trade idea when context score clears threshold with confirming bearish pattern", () => {
    const ctx = createContext({
      close: 23_900,
      supertrendTrend: "DOWN",
      supertrendValue: 23_950,
      emaFast: 23_920,
      vwap: 23_910, // price below vwap (+2)
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "RESISTANCE",
          algorithmVersion: "price-action-v2",
          direction: "BEARISH",
          level: 23_910, // near resistance (+2)
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [
        {
          code: "SHOOTING_STAR",
          algorithmVersion: "candlestick-v1",
          direction: "BEARISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(1);
    const idea = ideas[0];
    expect(idea.side).toBe("SHORT");
    expect(idea.entryPrice).toBe(23_900);
    expect(idea.stopLoss).toBe(23_920); // 23900 + 20 * 1.0 = 23920
    expect(idea.targetPrice).toBe(23_870); // 23900 - 20 * 1.5 = 23870
    expect(idea.riskReward).toBe(1.5);
  });

  it("rejects proposal when pattern is absent even if context score is high", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "UP",
      vwap: 23_990,
      priceActionEvents: [
        {
          eventCode: "SUPPORT",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 23_995,
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [], // No pattern trigger
    });

    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(0);
  });

  it("rejects proposal when context score is below configured threshold", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "DOWN", // Trend mismatch (0)
      vwap: 24_100, // Below VWAP (0 for long)
      priceActionEvents: [], // No support (0)
      volume: 100, // Volume (+1)
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    // Score = 1, threshold = 5
    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(0);
  });

  it("safely handles zero or negative ATR without throwing errors", () => {
    const ctx = createContext({
      atr: 0,
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas).toEqual([]);
  });

  it("applies higher-timeframe confluence bonus when HTF trend agrees and near HTF support", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "UP", // +2
      vwap: 23_990, // +2
      atr: 20,
      volume: 1000, // +1 (total base = 5)
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    // Add higher timeframes: 15m bullish (+1), near 15m support 23990 (+1) -> +2 HTF -> total score 7/9
    ctx.higherTimeframes = [
      {
        htfTimeframe: "15m",
        trendBias: "BULLISH",
        trendConfidence: 0.8,
        nearestSupportLevel: 23_990,
        nearestResistanceLevel: 24_500,
        chartPatterns: [],
      },
      {
        htfTimeframe: "60m",
        trendBias: "BULLISH",
        trendConfidence: 0.85,
        nearestSupportLevel: 23_800,
        nearestResistanceLevel: 24_600,
        chartPatterns: [],
      },
    ];

    const ideas = strategy.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(1);
    expect(ideas[0].reasoning[0]).toContain("Score: 7/9");
    expect(ideas[0].evidenceItems.some((e) => e.sourceReference === "HTF_CONFLUENCE")).toBe(true);
  });
});

describe("MomentumScalpPatternStrategyV2 & Configuration Hashing", () => {
  const strategyV2 = new MomentumScalpPatternStrategyV2();

  it("produces deterministic configurationHash independent of object key order (A == B)", () => {
    const configA = {
      scoreThreshold: 5,
      atrStopMultiple: 1.0,
      rewardRiskMultiple: 1.5,
      maxSrDistanceAtr: 1.5,
      volumeSurgeRatio: 1.1,
      expiryCandles: 3,
      indicatorAlgorithmVersion: "ta-v1",
      candlestickAlgorithmVersion: "candlestick-v1",
      priceActionAlgorithmVersion: "price-action-v2",
    };

    const configB = {
      priceActionAlgorithmVersion: "price-action-v2",
      candlestickAlgorithmVersion: "candlestick-v1",
      indicatorAlgorithmVersion: "ta-v1",
      expiryCandles: 3,
      volumeSurgeRatio: 1.1,
      maxSrDistanceAtr: 1.5,
      rewardRiskMultiple: 1.5,
      atrStopMultiple: 1.0,
      scoreThreshold: 5,
    };

    expect(computeConfigurationHash(configA)).toBe(computeConfigurationHash(configB));
  });

  it("produces distinct configurationHash when behavior-affecting parameter changes (A != B)", () => {
    const configA = { ...defaultMomentumScalpPatternStrategyConfiguration, scoreThreshold: 5 };
    const configB = { ...defaultMomentumScalpPatternStrategyConfiguration, scoreThreshold: 6 };

    expect(computeConfigurationHash(configA)).not.toBe(computeConfigurationHash(configB));
  });

  it("persists 4-layer metadata with featureSchemaVersion = null for rule-based trades", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "UP",
      vwap: 23_990,
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "SUPPORT",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 23_990,
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const ideas = strategyV2.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(1);
    const idea = ideas[0];
    expect(idea.evidence).toMatchObject({
      strategyVersion: "momentum-scalp-pattern-v2",
      candlestickEngineVersion: "candlestick-v1",
      chartPatternEngineVersion: "price-action-v2",
      featureSchemaVersion: null,
    });
    expect(typeof (idea.evidence as any).configurationHash).toBe("string");
    expect((idea.evidence as any).configurationHash.length).toBe(64); // SHA-256 hex
  });

  it("enforces mandatory downtrend verification for Inverted Hammer in Strategy V2", () => {
    // 1. Inverted Hammer during UPTREND -> rejected
    const uptrendCtx = createContext({
      close: 24_000,
      supertrendTrend: "UP",
      supertrendValue: 23_950,
      emaFast: 23_980,
      vwap: 23_990,
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "SUPPORT",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 23_990,
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [
        {
          code: "INVERTED_HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const uptrendIdeas = strategyV2.evaluate(uptrendCtx, CONFIGURATION);
    expect(uptrendIdeas.length).toBe(0);

    // 2. Inverted Hammer during DOWNTREND near support -> accepted with bonus
    const downtrendCtx = createContext({
      close: 24_000,
      supertrendTrend: "DOWN",
      supertrendValue: 24_100,
      emaFast: 24_050,
      vwap: 24_005, // within 0.5 ATR (+2)
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "SUPPORT",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 23_990, // near support (+2, plus Inverted Hammer support bonus +1)
          confidence: 0.8,
          details: {},
        },
      ],
      patterns: [
        {
          code: "INVERTED_HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const downtrendIdeas = strategyV2.evaluate(downtrendCtx, { ...CONFIGURATION, scoreThreshold: 5 });
    expect(downtrendIdeas.length).toBe(1);
    expect(downtrendIdeas[0].side).toBe("LONG");
    expect(downtrendIdeas[0].evidenceItems.some((e) => e.sourceReference === "INVERTED_HAMMER_SUPPORT")).toBe(true);
  });

  it("awards +2 confluence points for confirming macro chart patterns (e.g. INVERSE_HEAD_AND_SHOULDERS)", () => {
    const ctx = createContext({
      close: 24_000,
      supertrendTrend: "UP",
      vwap: 23_990,
      atr: 20,
      priceActionEvents: [
        {
          eventCode: "INVERSE_HEAD_AND_SHOULDERS",
          algorithmVersion: "price-action-v2",
          direction: "BULLISH",
          level: 24_000,
          confidence: 0.85,
          details: {},
        },
      ],
      patterns: [
        {
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.85,
          contextCandleIds: ["candle-1"],
          details: {},
        },
      ],
    });

    const ideas = strategyV2.evaluate(ctx, CONFIGURATION);
    expect(ideas.length).toBe(1);
    expect(ideas[0].evidenceItems.some((e) => e.sourceReference === "INVERSE_HEAD_AND_SHOULDERS")).toBe(true);
  });
});

