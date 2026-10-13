import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  digestHigherTimeframeContexts,
  trendSlicesFromHigherTimeframeContexts,
} from "./digest-higher-timeframes.js";

function ctx(overrides: {
  timeframe: string;
  close: number;
  ema?: number;
  supertrend?: number;
  support?: number;
  resistance?: number;
}): StrategyMarketContext {
  const indicators: StrategyMarketContext["indicators"] = [];
  if (overrides.ema !== undefined) {
    indicators.push({
      code: "EMA",
      algorithmVersion: "ta-v1",
      parameters: { period: 20 },
      values: { value: overrides.ema },
    });
  }
  if (overrides.supertrend !== undefined) {
    indicators.push({
      code: "SUPERTREND",
      algorithmVersion: "ta-v1",
      parameters: { atrPeriod: 10, multiplier: 3 },
      values: {
        value: overrides.supertrend,
        trend: overrides.close > overrides.supertrend ? "UP" : "DOWN",
      },
    });
  }
  const priceActionEvents: StrategyMarketContext["priceActionEvents"] = [];
  if (overrides.support !== undefined) {
    priceActionEvents.push({
      eventCode: "SUPPORT",
      algorithmVersion: "price-action-v2",
      direction: "BULLISH",
      level: overrides.support,
      confidence: 0.8,
      details: {},
    });
  }
  if (overrides.resistance !== undefined) {
    priceActionEvents.push({
      eventCode: "RESISTANCE",
      algorithmVersion: "price-action-v2",
      direction: "BEARISH",
      level: overrides.resistance,
      confidence: 0.8,
      details: {},
    });
  }
  return {
    candle: {
      id: `c-${overrides.timeframe}`,
      instrumentId: "i1",
      timeframe: overrides.timeframe,
      openTime: new Date("2026-10-13T03:30:00Z"),
      closeTime: new Date("2026-10-13T03:45:00Z"),
      open: overrides.close,
      high: overrides.close + 1,
      low: overrides.close - 1,
      close: overrides.close,
      volume: 1,
      tickSize: 0.05,
    },
    indicators,
    patterns: [],
    priceActionEvents,
  };
}

describe("digestHigherTimeframeContexts", () => {
  it("returns empty when nothing attached", () => {
    expect(digestHigherTimeframeContexts(undefined)).toEqual([]);
    expect(digestHigherTimeframeContexts({})).toEqual([]);
  });

  it("digests bullish 5m/15m into HigherTimeframeContext with S/R", () => {
    const attached = {
      "5m": ctx({ timeframe: "5m", close: 100, ema: 99, supertrend: 98, support: 95, resistance: 105 }),
      "15m": ctx({ timeframe: "15m", close: 100, ema: 98, supertrend: 97 }),
    };
    const digested = digestHigherTimeframeContexts(attached);
    expect(digested).toHaveLength(2);
    expect(digested[0]!.htfTimeframe).toBe("5m");
    expect(digested[0]!.trendBias).toBe("BULLISH");
    expect(digested[0]!.nearestSupportLevel).toBe(95);
    expect(digested[0]!.nearestResistanceLevel).toBe(105);
    expect(digested[1]!.htfTimeframe).toBe("15m");
    expect(digested[1]!.trendBias).toBe("BULLISH");
  });

  it("exposes trend slices for the market-context map", () => {
    const slices = trendSlicesFromHigherTimeframeContexts({
      "5m": ctx({ timeframe: "5m", close: 100, ema: 99, supertrend: 98 }),
      "15m": ctx({ timeframe: "15m", close: 100, ema: 101, supertrend: 102 }),
    });
    expect(slices.tf5?.soft).toBe("UP");
    expect(slices.tf15?.soft).toBe("DOWN");
  });
});
