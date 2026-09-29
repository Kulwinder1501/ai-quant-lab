import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  defaultTrendContinuationStrategyConfiguration,
  TrendContinuationStrategy,
  TREND_CONTINUATION_STRATEGY_KEY,
} from "./trend-continuation-strategy.js";

function buildMockContext(trend: "BULLISH" | "BEARISH" = "BULLISH"): StrategyMarketContext {
  const closeTime = new Date("2026-09-29T10:00:00Z");

  return {
    candle: {
      id: "candle-1",
      instrumentId: "BANKNIFTY",
      timeframe: "5m",
      openTime: new Date("2026-09-29T09:55:00Z"),
      closeTime,
      open: 50000,
      high: 50100,
      low: 49900,
      close: trend === "BULLISH" ? 50080 : 49920,
      volume: 1000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "ATR", algorithmVersion: "v1", parameters: {}, values: { value: 20 } },
    ],
    ictSnapshot: {
      timestamp: closeTime,
      structure: {
        trend,
      } as any,
      swingHierarchy: {
        nearestIntermediateTermHigh: trend === "BULLISH" ? null : { price: 50500 } as any,
        nearestIntermediateTermLow: trend === "BULLISH" ? { price: 49500 } as any : null,
        nearestShortTermHigh: trend === "BULLISH" ? null : { price: 50200 } as any,
        nearestShortTermLow: trend === "BULLISH" ? { price: 49800 } as any : null,
        classifiedSwings: [],
      } as any,
      cisd: {
        direction: trend,
        ageBars: 2,
      } as any,
    } as any,
  } as unknown as StrategyMarketContext;
}

describe("TrendContinuationStrategy", () => {
  it("evaluates trend continuation signals when gates align", () => {
    const strategy = new TrendContinuationStrategy();
    const context = buildMockContext("BULLISH");
    const config = {
      ...defaultTrendContinuationStrategyConfiguration,
      requireMinorSweep: false,
    };

    const ideas = strategy.evaluate(context, config);
    expect(ideas.length).toBe(1);
    expect(ideas[0].side).toBe("LONG");
    expect(ideas[0].targetPrice).toBeGreaterThan(ideas[0].entryPrice);
    expect(ideas[0].riskReward).toBe(1.5);
  });

  it("returns no proposals when trend slope is neutral", () => {
    const strategy = new TrendContinuationStrategy();
    const context = buildMockContext("BULLISH");
    (context.ictSnapshot as any).structure.trend = "NEUTRAL";

    const ideas = strategy.evaluate(context, defaultTrendContinuationStrategyConfiguration);
    expect(ideas).toEqual([]);
  });
});
