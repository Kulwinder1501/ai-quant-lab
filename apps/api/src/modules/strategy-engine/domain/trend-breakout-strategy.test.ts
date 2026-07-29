import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  defaultTrendBreakoutStrategyConfiguration,
  TrendBreakoutStrategy,
} from "./trend-breakout-strategy.js";

function configuration(): Record<string, unknown> {
  return { ...defaultTrendBreakoutStrategyConfiguration } as Record<string, unknown>;
}

function qualifyingLongContext(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-long",
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: new Date("2026-07-24T09:15:00.000Z"),
      closeTime: new Date("2026-07-24T15:30:00.000Z"),
      open: 99.5,
      high: 101,
      low: 99,
      close: 100.03,
      volume: 100_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 98 } },
      { code: "SMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 99 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 60 } },
      { code: "MACD", algorithmVersion: "ta-v1", parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, values: { histogram: 0.8 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 1.02 } },
      { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { trend: "UP" } },
    ],
    patterns: [{
      code: "BULLISH_ENGULFING",
      algorithmVersion: "candlestick-v1",
      direction: "BULLISH",
      confidence: 0.9,
      contextCandleIds: ["previous-candle", "candle-long"],
      details: { bodyRatio: 1.4 },
    }],
    priceActionEvents: [{
      eventCode: "BREAKOUT",
      algorithmVersion: "price-action-v2",
      direction: "BULLISH",
      level: 100,
      confidence: 0.9,
      details: { resistance: 100 },
    }],
  };
}

function qualifyingShortContext(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-short",
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: new Date("2026-07-24T09:15:00.000Z"),
      closeTime: new Date("2026-07-24T15:30:00.000Z"),
      open: 100.5,
      high: 101,
      low: 99,
      close: 99.98,
      volume: 100_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 102 } },
      { code: "SMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 101 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 40 } },
      { code: "MACD", algorithmVersion: "ta-v1", parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, values: { histogram: -0.7 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 1.01 } },
      { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { trend: "DOWN" } },
    ],
    patterns: [{
      code: "BEARISH_ENGULFING",
      algorithmVersion: "candlestick-v1",
      direction: "BEARISH",
      confidence: 0.91,
      contextCandleIds: ["previous-candle", "candle-short"],
      details: { bodyRatio: 1.3 },
    }],
    priceActionEvents: [{
      eventCode: "BREAKDOWN",
      algorithmVersion: "price-action-v2",
      direction: "BEARISH",
      level: 100,
      confidence: 0.92,
      details: { support: 100 },
    }],
  };
}

describe("TrendBreakoutStrategy", () => {
  const strategy = new TrendBreakoutStrategy();

  it("proposes a qualifying long with tick-rounded risk levels and close-time evidence", () => {
    const [proposal] = strategy.evaluate(qualifyingLongContext(), configuration());

    expect(proposal).toMatchObject({
      side: "LONG",
      entryPrice: 100.05,
      stopLoss: 98.5,
      targetPrice: 103.15,
      riskReward: 2,
      evidence: {
        strategy: "trend-breakout",
        strategyVersion: 2,
        sourceCandleId: "candle-long",
        trigger: "BREAKOUT",
        pattern: "BULLISH_ENGULFING",
      },
    });
    expect(proposal.confidence).toBeCloseTo(0.948, 10);
    expect(proposal.expiresAt).toEqual(new Date("2026-07-25T15:30:00.000Z"));
    expect(proposal.evidenceItems.map((item) => item.sourceType)).toEqual([
      "INDICATOR", "INDICATOR", "INDICATOR", "INDICATOR", "INDICATOR", "INDICATOR",
      "PATTERN", "PRICE_ACTION", "STRATEGY",
    ]);
    expect(proposal.evidenceItems.at(-1)).toMatchObject({
      sourceReference: "trend-breakout:v2",
      details: { sourceCandleId: "candle-long", timeframe: "1d" },
    });
    expect(proposal.reasoning.at(-1)).toBe(
      "This is a close-time paper-trade proposal only; a later phase simulates an eligible next-candle fill.",
    );
    expect(proposal).not.toHaveProperty("order");
  });

  it("proposes a qualifying short with protective tick rounding away from the entry", () => {
    const [proposal] = strategy.evaluate(qualifyingShortContext(), configuration());

    expect(proposal).toMatchObject({
      side: "SHORT",
      entryPrice: 100,
      stopLoss: 101.55,
      targetPrice: 96.9,
      riskReward: 2,
      evidence: {
        sourceCandleId: "candle-short",
        trigger: "BREAKDOWN",
        pattern: "BEARISH_ENGULFING",
      },
    });
    expect(proposal.confidence).toBeCloseTo(0.9562, 10);
    expect(proposal.evidenceItems.find((item) => item.sourceType === "PRICE_ACTION")).toMatchObject({
      sourceReference: "BREAKDOWN:price-action-v2",
      label: "BREAKDOWN is the bearish entry trigger",
    });
  });

  it("gates each side on the measured volatility regime", () => {
    const lowVol = { ...qualifyingLongContext(), regime: { regime: "LOW_VOL" as const, valueRatio: 0.9 } };
    const highVol = { ...qualifyingLongContext(), regime: { regime: "HIGH_VOL" as const, valueRatio: 1.2 } };

    expect(strategy.evaluate(lowVol, configuration())).toHaveLength(1);
    expect(strategy.evaluate(highVol, configuration())).toHaveLength(0);

    const regimeEvidence = strategy.evaluate(lowVol, configuration())[0].evidenceItems
      .find((item) => item.sourceType === "REGIME");
    expect(regimeEvidence).toMatchObject({
      sourceReference: "VIX_SMA20",
      contribution: null,
      details: { regime: "LOW_VOL", valueRatio: 0.9 },
    });
  });

  it("treats an unknown regime according to the configured requirement", () => {
    const withoutRegime = qualifyingLongContext();
    expect(withoutRegime.regime).toBeUndefined();

    expect(strategy.evaluate(withoutRegime, configuration())).toHaveLength(1);
    expect(strategy.evaluate(withoutRegime, { ...configuration(), requireRegime: true })).toHaveLength(0);
  });

  it("refuses proposals when a required indicator, pattern, or price-action evidence category is absent", () => {
    const complete = qualifyingLongContext();
    const missingIndicator: StrategyMarketContext = {
      ...complete,
      indicators: complete.indicators.filter((indicator) => indicator.code !== "ATR"),
    };
    const missingPattern: StrategyMarketContext = { ...complete, patterns: [] };
    const missingPriceAction: StrategyMarketContext = { ...complete, priceActionEvents: [] };

    expect(strategy.evaluate(missingIndicator, configuration())).toEqual([]);
    expect(strategy.evaluate(missingPattern, configuration())).toEqual([]);
    expect(strategy.evaluate(missingPriceAction, configuration())).toEqual([]);
  });
});
