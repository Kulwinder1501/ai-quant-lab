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
        raw_di: -0.35,
        di_tilde: 0.25,
        directional_bias: "BULLISH_REJECTION",
        gate_action: "BUY_CALL_OR_LONG",
      },
      optionChainSignal: {
        pcr: 1.4,
        callOpenInterest: 100_000,
        putOpenInterest: 140_000,
        observedAt: new Date("2026-09-28T10:02:00Z"),
        ageMinutes: 3,
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("LONG");
    expect(p.entryPrice).toBe(54580);
    expect(p.stopLoss).toBeLessThan(54580);
    expect(p.targetPrice).toBeGreaterThan(54580);
    expect(p.confidence).toBeGreaterThanOrEqual(0.85);
    expect(p.confidence).toBeLessThanOrEqual(0.95);
    expect(p.reasoning[0]).toContain("[Pillar A PASS]");
    expect(p.reasoning[1]).toContain("[Pillar B PASS]");
    expect(p.reasoning[1]).not.toContain("Order Flow");
    expect(p.reasoning[2]).toContain("[Pillar C PASS]");
    expect(p.evidence.pillarC).toEqual({ pcr: 1.4, oiWallConfirmed: true });
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
      optionChainSignal: {
        pcr: 0.6,
        callOpenInterest: 140_000,
        putOpenInterest: 84_000,
        observedAt: new Date("2026-09-28T10:02:00Z"),
        ageMinutes: 3,
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

  it("rejects a LONG setup when PCR is unmeasured, rather than defaulting to a pass", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: true,
        nearest_level_type: "SWING_LOW",
        nearest_level_price: 54575,
        distance_bps: 1,
        raw_di: -0.35,
        di_tilde: 0.25,
        directional_bias: "BULLISH_REJECTION",
        gate_action: "BUY_CALL_OR_LONG",
      },
      // No optionChainSignal at all -- the pre-2026-09-28 stub would have passed this
      // silently (nothing ever set priceActionEvents[].details.oiSupport/oiResistance to
      // false). The real gate must refuse instead of defaulting to a pass.
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toEqual([]);
  });

  it("rejects a LONG setup when PCR is measured but on the wrong side of the wall", () => {
    const ctx = mockContext({
      confluenceSignal: {
        is_level_proximate: true,
        nearest_level_type: "SWING_LOW",
        nearest_level_price: 54575,
        distance_bps: 1,
        raw_di: -0.35,
        di_tilde: 0.25,
        directional_bias: "BULLISH_REJECTION",
        gate_action: "BUY_CALL_OR_LONG",
      },
      optionChainSignal: {
        pcr: 0.95, // below the 1.2 LONG floor
        callOpenInterest: 100_000,
        putOpenInterest: 95_000,
        observedAt: new Date("2026-09-28T10:02:00Z"),
        ageMinutes: 3,
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toEqual([]);
  });

  it("rejects a SHORT setup when PCR is measured but on the wrong side of the wall", () => {
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
      optionChainSignal: {
        pcr: 0.9, // above the 0.8 SHORT ceiling
        callOpenInterest: 100_000,
        putOpenInterest: 90_000,
        observedAt: new Date("2026-09-28T10:02:00Z"),
        ageMinutes: 3,
      },
    });
    const proposals = strategy.evaluate(ctx, {});
    expect(proposals).toEqual([]);
  });
  it("emits a LONG at a support level from the SAME sign convention as SHORT (sell-heavy depth, -DI)", () => {
    // Regression for the audit: Pillar A needs di_tilde = -DI > 0.10 and Pillar B used to demand
    // raw_di >= +0.05 for LONG, so LONG was unreachable and its test only passed with the
    // impossible pair raw_di=0.35 / di_tilde=0.35.
    for (const [type, action, bias, pcr, side] of [
      ["SWING_LOW", "BUY_CALL_OR_LONG", "BULLISH_REJECTION", 1.4, "LONG"],
      ["SWING_HIGH", "BUY_PUT_OR_SHORT", "BEARISH_REJECTION", 0.6, "SHORT"],
    ] as const) {
      const proposals = strategy.evaluate(
        mockContext({
          confluenceSignal: {
            is_level_proximate: true,
            nearest_level_type: type,
            nearest_level_price: 54580,
            distance_bps: 1,
            raw_di: -0.30,
            di_tilde: 0.20,
            directional_bias: bias,
            gate_action: action,
          },
          optionChainSignal: { pcr, callOpenInterest: 1, putOpenInterest: 1, observedAt: new Date("2026-09-28T10:02:00Z"), ageMinutes: 3 },
        }),
        {},
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.side).toBe(side);
      expect(proposals[0]!.evidence.pillarB).toMatchObject({ kind: "STATIC_DEPTH_IMBALANCE", isDepthImbalanceAligned: true });
    }
  });

  it("keeps confidence on the 0-1 scale", () => {
    const proposals = strategy.evaluate(
      mockContext({
        confluenceSignal: {
          is_level_proximate: true,
          nearest_level_type: "SWING_LOW",
          nearest_level_price: 54580,
          distance_bps: 1,
          raw_di: -0.9,
          di_tilde: 1.5, // large detrended value must not escape [0, 1]
          directional_bias: "BULLISH_REJECTION",
          gate_action: "BUY_CALL_OR_LONG",
        },
        optionChainSignal: { pcr: 1.5, callOpenInterest: 1, putOpenInterest: 1, observedAt: new Date("2026-09-28T10:02:00Z"), ageMinutes: 3 },
      }),
      {},
    );
    expect(proposals[0]!.confidence).toBeLessThanOrEqual(0.95);
    expect(proposals[0]!.confidence).toBeGreaterThan(0);
  });

  it("rejects when the raw depth is buy-heavy even if di_tilde is positive (Pillar B disagrees)", () => {
    const proposals = strategy.evaluate(
      mockContext({
        confluenceSignal: {
          is_level_proximate: true,
          nearest_level_type: "SWING_LOW",
          nearest_level_price: 54580,
          distance_bps: 1,
          raw_di: 0.2,
          di_tilde: 0.2,
          directional_bias: "BULLISH_REJECTION",
          gate_action: "BUY_CALL_OR_LONG",
        },
        optionChainSignal: { pcr: 1.4, callOpenInterest: 1, putOpenInterest: 1, observedAt: new Date("2026-09-28T10:02:00Z"), ageMinutes: 3 },
      }),
      {},
    );
    expect(proposals).toEqual([]);
  });

  it("rejects when raw_di is missing rather than defaulting it to a confirming 0", () => {
    const proposals = strategy.evaluate(
      mockContext({
        confluenceSignal: {
          is_level_proximate: true,
          nearest_level_type: "SWING_LOW",
          nearest_level_price: 54580,
          distance_bps: 1,
          raw_di: null,
          di_tilde: 0.3,
          directional_bias: "BULLISH_REJECTION",
          gate_action: "BUY_CALL_OR_LONG",
        },
        optionChainSignal: { pcr: 1.4, callOpenInterest: 1, putOpenInterest: 1, observedAt: new Date("2026-09-28T10:02:00Z"), ageMinutes: 3 },
      }),
      {},
    );
    expect(proposals).toEqual([]);
  });
});
