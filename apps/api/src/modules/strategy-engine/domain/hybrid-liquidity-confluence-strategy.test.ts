import { describe, expect, it } from "vitest";
import { HybridLiquidityConfluenceStrategy } from "./hybrid-liquidity-confluence-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";

function mockContext(overrides?: Partial<StrategyMarketContext>): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "inst-1",
      timeframe: "5m",
      openTime: new Date("2026-09-28T10:00:00Z"),
      closeTime: new Date("2026-09-28T10:05:00Z"),
      open: 54500,
      high: 54600,
      low: 54480,
      close: 54580,
      volume: 1000,
      tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    ...overrides,
  };
}

describe("HybridLiquidityConfluenceStrategy", () => {
  const strategy = new HybridLiquidityConfluenceStrategy();

  it("has strategyKey hybrid-liquidity-confluence-v1", () => {
    expect(strategy.strategyKey).toBe("hybrid-liquidity-confluence-v1");
  });

  it("returns no proposals when level is not proximate", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: false,
        nearest_level_type: "SWING_LOW",
        nearest_level_price: 54400,
        distance_bps: 33,
        raw_di: 0.2,
        di_tilde: 0.2,
        directional_bias: "NONE",
        gate_action: "NO_ACTION",
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toEqual([]);
  });

  it("returns no proposals when di_tilde is weak or non-positive", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: true,
        nearest_level_type: "SWING_LOW",
        nearest_level_price: 54575,
        distance_bps: 1,
        raw_di: 0.02,
        di_tilde: 0.05,
        directional_bias: "BULLISH_REJECTION",
        gate_action: "BUY_CALL_OR_LONG",
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toEqual([]);
  });

  it("emits LONG proposal when all 3 institutional pillars pass", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: true,
        nearest_level_type: "SWING_LOW",
        nearest_level_price: 54575,
        distance_bps: 1,
        raw_di: 0.35,
        di_tilde: 0.35,
        directional_bias: "BULLISH_REJECTION",
        gate_action: "BUY_CALL_OR_LONG",
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("LONG");
    expect(p.entryPrice).toBe(54580);
    expect(p.stopLoss).toBeLessThan(54580);
    expect(p.targetPrice).toBeGreaterThan(54580);
    expect(p.confidence).toBeGreaterThanOrEqual(85);
    expect(p.reasoning[0]).toContain("[Pillar A PASS]");
    expect(p.reasoning[1]).toContain("[Pillar B PASS]");
    expect(p.reasoning[2]).toContain("[Pillar C PASS]");
  });

  it("emits SHORT proposal when all 3 institutional pillars pass for sell side", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: true,
        nearest_level_type: "SWING_HIGH",
        nearest_level_price: 54585,
        distance_bps: 1,
        raw_di: -0.30,
        di_tilde: 0.30,
        directional_bias: "BEARISH_REJECTION",
        gate_action: "BUY_PUT_OR_SHORT",
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("SHORT");
    expect(p.entryPrice).toBe(54580);
    expect(p.stopLoss).toBeGreaterThan(54580);
    expect(p.targetPrice).toBeLessThan(54580);
  });
});
