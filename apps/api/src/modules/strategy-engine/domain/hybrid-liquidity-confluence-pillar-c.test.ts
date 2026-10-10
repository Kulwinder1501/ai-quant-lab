import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridLiquidityConfluenceStrategy } from "./hybrid-liquidity-confluence-strategy.js";
import { unavailableOptionChainSignal } from "./option-chain-signal.js";
import type { StrategyMarketContext } from "./strategy.js";

// Pillars A and B pass for a SHORT at a session high; only the PCR varies.
function context(optionChainSignal?: StrategyMarketContext["optionChainSignal"]): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "inst-1", timeframe: "5m",
      openTime: new Date("2026-09-28T10:00:00Z"), closeTime: new Date("2026-09-28T10:05:00Z"),
      open: 54500, high: 54600, low: 54480, close: 54580, volume: 1000, tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    confluenceSignal: {
      is_level_proximate: true,
      nearest_level_type: "SESSION_HIGH",
      nearest_level_price: 54585,
      distance_bps: 1,
      // di_tilde = -raw_di for both pillars: a negative raw book DI is what supports this direction.
      raw_di: -0.35,
      di_tilde: 0.35,
      directional_bias: "BEARISH_REJECTION",
      gate_action: "BUY_PUT_OR_SHORT",
    },
    ...(optionChainSignal ? { optionChainSignal } : {}),
  };
}

describe("HybridLiquidityConfluenceStrategy Pillar C PCR handling", () => {
  const strategy = new HybridLiquidityConfluenceStrategy();
  afterEach(() => vi.restoreAllMocks());

  it("surfaces 'PCR unavailable (stale)' explicitly when A and B pass but the PCR is stale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const proposals = strategy.evaluate(context(unavailableOptionChainSignal("STALE", {
      expiryDate: "2026-09-29", ageMinutes: 31,
    })), {});

    expect(proposals).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(logged).toMatchObject({
      message: "PCR unavailable (stale)",
      unavailableReason: "STALE",
      ageMinutes: 31,
      expiryDate: "2026-09-29",
      pillarC: "UNCONFIRMED",
      proposedSide: "SHORT",
    });
  });

  it("names the absence when no option-chain signal was resolved at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(strategy.evaluate(context(), {})).toEqual([]);

    expect(JSON.parse(String(warn.mock.calls[0]![0])).unavailableReason).toBe("NO_SIGNAL");
  });

  it("does not log when the PCR is simply not confirming (that is a real rejection, not missing data)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const proposals = strategy.evaluate(context({
      pcr: 1.3, callOpenInterest: 100, putOpenInterest: 130, observedAt: new Date(), ageMinutes: 2,
    }), {});

    expect(proposals).toEqual([]); // SHORT needs PCR <= 0.8
    expect(warn).not.toHaveBeenCalled();
  });

  it("confirms a SHORT on a measured PCR at or below 0.8", () => {
    const proposals = strategy.evaluate(context({
      pcr: 0.7, callOpenInterest: 100, putOpenInterest: 70, observedAt: new Date(), ageMinutes: 2,
    }), {});

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.evidence.pillarC).toEqual({ pcr: 0.7, oiWallConfirmed: true });
  });
});
