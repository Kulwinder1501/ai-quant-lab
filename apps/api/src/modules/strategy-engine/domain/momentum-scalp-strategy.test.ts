import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  defaultMomentumScalpStrategyConfiguration,
  momentumScalpStrategyRegistration,
  MomentumScalpStrategy,
  parseMomentumScalpStrategyConfiguration,
} from "./momentum-scalp-strategy.js";

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...defaultMomentumScalpStrategyConfiguration, ...overrides } as Record<string, unknown>;
}

/**
 * ATR is 10, so one ATR of VWAP displacement is 10 points. Close sits 7.5 points
 * above VWAP, which is 0.75 ATR — the configured ideal displacement.
 */
function qualifyingLongContext(overrides: {
  close?: number;
  vwap?: number;
  rsi?: number;
  emaFast?: number;
  emaSlow?: number;
  timeframe?: string;
} = {}): StrategyMarketContext {
  const close = overrides.close ?? 1007.5;
  return {
    candle: {
      id: "candle-scalp-long",
      instrumentId: "instrument-1",
      timeframe: overrides.timeframe ?? "1m",
      openTime: new Date("2026-07-29T05:00:00.000Z"),
      closeTime: new Date("2026-07-29T05:01:00.000Z"),
      open: close - 1,
      high: close + 0.5,
      low: close - 1.5,
      close,
      volume: 100_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 9 }, values: { value: overrides.emaFast ?? 1005 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: overrides.emaSlow ?? 1000 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: overrides.rsi ?? 70 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: overrides.vwap ?? 1000 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 10 } },
    ],
    patterns: [],
    priceActionEvents: [],
  };
}

function qualifyingShortContext(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-scalp-short",
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-07-29T05:00:00.000Z"),
      closeTime: new Date("2026-07-29T05:01:00.000Z"),
      open: 993,
      high: 993.5,
      low: 992,
      close: 992.5,
      volume: 100_000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 9 }, values: { value: 995 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 1000 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 30 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 1000 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 10 } },
    ],
    patterns: [],
    priceActionEvents: [],
  };
}

describe("MomentumScalpStrategy configuration", () => {
  it("parses the configuration it registers", () => {
    // The regression that motivated this file: v1 registered VWAP: {} while the
    // parser rejected an empty parameter set, so evaluate() threw on every call
    // and the strategy could never produce an idea.
    expect(() => parseMomentumScalpStrategyConfiguration(momentumScalpStrategyRegistration.configuration)).not.toThrow();
  });

  it("rejects a non-monotonic displacement band", () => {
    expect(() => parseMomentumScalpStrategyConfiguration(configuration({
      minimumVwapDisplacementAtr: 1,
      idealVwapDisplacementAtr: 0.5,
    }))).toThrow(/minimumVwapDisplacementAtr < idealVwapDisplacementAtr/);
  });

  it("rejects an inverted RSI band", () => {
    expect(() => parseMomentumScalpStrategyConfiguration(configuration({ rsiLongMax: 50, rsiLongMin: 60 })))
      .toThrow(/rsiLongMax to be greater than rsiLongMin/);
  });

  it("requires a VWAP parameter set", () => {
    expect(() => parseMomentumScalpStrategyConfiguration(configuration({
      indicatorParameters: { ...defaultMomentumScalpStrategyConfiguration.indicatorParameters, VWAP: {} },
    }))).toThrow(/requires parameters for VWAP/);
  });
});

describe("MomentumScalpStrategy evaluation", () => {
  it("proposes a long when EMA separation, VWAP displacement, and RSI all agree", () => {
    const [proposal] = new MomentumScalpStrategy().evaluate(qualifyingLongContext(), configuration());
    expect(proposal).toBeDefined();
    expect(proposal.side).toBe("LONG");
    expect(proposal.stopLoss).toBeLessThan(proposal.entryPrice);
    expect(proposal.targetPrice).toBeGreaterThan(proposal.entryPrice);
  });

  it("proposes a short in the mirrored setup", () => {
    const [proposal] = new MomentumScalpStrategy().evaluate(qualifyingShortContext(), configuration());
    expect(proposal).toBeDefined();
    expect(proposal.side).toBe("SHORT");
    expect(proposal.stopLoss).toBeGreaterThan(proposal.entryPrice);
    expect(proposal.targetPrice).toBeLessThan(proposal.entryPrice);
  });

  it("rejects a bar hovering at VWAP as chop", () => {
    // 0.05 ATR of displacement is below minimumVwapDisplacementAtr. v1 scored
    // this setup *highest*, because its confidence decreased with distance.
    const context = qualifyingLongContext({ close: 1000.5 });
    expect(new MomentumScalpStrategy().evaluate(context, configuration())).toHaveLength(0);
  });

  it("rejects an already-extended move rather than chasing it", () => {
    // 3 ATR above VWAP, past maximumVwapDisplacementAtr.
    const context = qualifyingLongContext({ close: 1030 });
    expect(new MomentumScalpStrategy().evaluate(context, configuration())).toHaveLength(0);
  });

  it("scores confirmed displacement above marginal displacement", () => {
    const strategy = new MomentumScalpStrategy();
    const [ideal] = strategy.evaluate(qualifyingLongContext({ close: 1007.5 }), configuration());
    const [marginal] = strategy.evaluate(qualifyingLongContext({ close: 1002.5 }), configuration());
    expect(ideal.confidence).toBeGreaterThan(marginal.confidence);
  });

  it("keeps confidence inside a range where the minimum can actually reject", () => {
    const [proposal] = new MomentumScalpStrategy().evaluate(qualifyingLongContext(), configuration());
    expect(proposal.confidence).toBeGreaterThan(0.3);
    expect(proposal.confidence).toBeLessThanOrEqual(1);
    // v1's range was [0.5, 0.7] against a 0.5 floor, so no setup was ever gated.
    const rejected = new MomentumScalpStrategy().evaluate(qualifyingLongContext(), configuration({ minimumConfidence: 0.99 }));
    expect(rejected).toHaveLength(0);
  });

  it("rejects an exhausted RSI outside the momentum band", () => {
    const context = qualifyingLongContext({ rsi: 95 });
    expect(new MomentumScalpStrategy().evaluate(context, configuration())).toHaveLength(0);
  });

  it("does not let the volatility regime pick a direction", () => {
    // v1 required LOW_VOL to go long and HIGH_VOL to go short, so a long setup in
    // a high-volatility tape was silently discarded.
    const context: StrategyMarketContext = {
      ...qualifyingLongContext(),
      regime: { regime: "HIGH_VOL", valueRatio: 1.4 },
    };
    const [proposal] = new MomentumScalpStrategy().evaluate(context, configuration({ requireRegime: true }));
    expect(proposal).toBeDefined();
    expect(proposal.side).toBe("LONG");
  });

  it("requires a measured regime when requireRegime is set", () => {
    const context = qualifyingLongContext();
    expect(context.regime).toBeUndefined();
    expect(new MomentumScalpStrategy().evaluate(context, configuration({ requireRegime: true }))).toHaveLength(0);
  });

  it("returns no proposal when an indicator is missing", () => {
    const context = qualifyingLongContext();
    const withoutVwap = { ...context, indicators: context.indicators.filter((indicator) => indicator.code !== "VWAP") };
    expect(new MomentumScalpStrategy().evaluate(withoutVwap, configuration())).toHaveLength(0);
  });

  it("expires an idea a whole number of bars after the source candle closed", () => {
    const context = qualifyingLongContext();
    const [proposal] = new MomentumScalpStrategy().evaluate(context, configuration());
    expect(proposal.expiresAt).not.toBeNull();
    expect(proposal.expiresAt!.getTime() - context.candle.closeTime.getTime()).toBe(5 * 60_000);
  });

  it("refuses an unrecognised timeframe instead of emitting an already-expired idea", () => {
    // v1 fell back to a zero-length bar, which set expiresAt equal to closeTime.
    const context = qualifyingLongContext({ timeframe: "weird" });
    expect(new MomentumScalpStrategy().evaluate(context, configuration())).toHaveLength(0);
  });
});
