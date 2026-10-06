import { describe, expect, it } from "vitest";
import {
  defaultMomentumScalpIndexStrategyConfiguration,
  MomentumScalpIndexStrategy,
  parseMomentumScalpIndexStrategyConfiguration,
} from "./momentum-scalp-index-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";

/**
 * The index scalp shipped with no tests, which is how its confidence floor came to be inert: the
 * formula's base equalled `minimumConfidence`, so the smallest value it could return already
 * cleared the gate. These fixtures pin the arithmetic as well as the branches.
 */

const CONFIGURATION = { ...defaultMomentumScalpIndexStrategyConfiguration } as Record<string, unknown>;

interface ContextOptions {
  close?: number;
  emaFast?: number;
  emaSlow?: number;
  rsi?: number;
  trend?: string;
  supertrendValue?: number;
  atr?: number;
  timeframe?: string;
  tickSize?: number;
}

function context(options: ContextOptions = {}): StrategyMarketContext {
  const close = options.close ?? 24_000;
  const parameters = defaultMomentumScalpIndexStrategyConfiguration.indicatorParameters;
  const snapshot = (
    code: string,
    params: Record<string, number | string | boolean>,
    values: Record<string, unknown>,
  ) => ({ code, algorithmVersion: "ta-v1", parameters: params, values });

  return {
    candle: {
      id: "candle-1",
      instrumentId: "inst-1",
      timeframe: options.timeframe ?? "1m",
      openTime: new Date("2026-08-11T04:00:00.000Z"),
      closeTime: new Date("2026-08-11T04:01:00.000Z"),
      open: close, high: close + 5, low: close - 5, close,
      volume: 0,
      tickSize: options.tickSize ?? 0.05,
    },
    indicators: [
      snapshot("EMA", parameters.EMA_FAST!, { value: options.emaFast ?? close + 6 }),
      snapshot("EMA", parameters.EMA_SLOW!, { value: options.emaSlow ?? close }),
      snapshot("RSI", parameters.RSI!, { value: options.rsi ?? 65 }),
      snapshot("SUPERTREND", parameters.SUPERTREND!, {
        trend: options.trend ?? "UP",
        value: options.supertrendValue ?? close - 12,
      }),
      snapshot("ATR", parameters.ATR!, { value: options.atr ?? 12 }),
    ],
    patterns: [],
    priceActionEvents: [],
    regime: null,
  } as unknown as StrategyMarketContext;
}

const strategy = new MomentumScalpIndexStrategy();

describe("MomentumScalpIndexStrategy direction gate", () => {
  it("raises a LONG when Supertrend is UP, fast EMA leads and RSI is in band", () => {
    const ideas = strategy.evaluate(context(), CONFIGURATION);

    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.side).toBe("LONG");
  });

  it("raises a SHORT on the mirrored evidence", () => {
    const ideas = strategy.evaluate(context({
      trend: "DOWN",
      emaFast: 23_994,
      emaSlow: 24_000,
      rsi: 35,
      supertrendValue: 24_012,
    }), CONFIGURATION);

    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.side).toBe("SHORT");
  });

  it("raises nothing when Supertrend disagrees with the EMA order", () => {
    // The whole point of the Supertrend gate: it replaces VWAP, which an index cannot supply.
    expect(strategy.evaluate(context({ trend: "DOWN" }), CONFIGURATION)).toHaveLength(0);
  });

  it("raises nothing when RSI sits outside the momentum band", () => {
    expect(strategy.evaluate(context({ rsi: 85 }), CONFIGURATION)).toHaveLength(0);
    expect(strategy.evaluate(context({ rsi: 50 }), CONFIGURATION)).toHaveLength(0);
  });

  it("raises nothing when a required indicator is absent", () => {
    const withoutSupertrend = context();
    (withoutSupertrend.indicators as unknown[]).splice(3, 1);

    expect(strategy.evaluate(withoutSupertrend, CONFIGURATION)).toHaveLength(0);
  });

  it("needs no VWAP, which is what makes it usable on an index", () => {
    // An index publishes no volume, so VWAP is unavailable. This strategy must never ask for it.
    const codes = context().indicators.map((indicator) => indicator.code);
    expect(codes).not.toContain("VWAP");
    expect(strategy.evaluate(context(), CONFIGURATION)).toHaveLength(1);
  });
});

describe("MomentumScalpIndexStrategy confidence floor", () => {
  /*
   * The regression. The formula was `0.5 + emaSpread*0.3 + rsi*0.2` against a floor of 0.5, so the
   * minimum attainable confidence *equalled* the threshold and the floor could never reject
   * anything. Scoring Supertrend headroom instead of assuming it restores a 0.3 base.
   */
  it("rejects a setup whose terms are all weak", () => {
    const ideas = strategy.evaluate(context({
      // EMA spread ~0, RSI at a band edge (score 0), price sitting on the Supertrend band (score 0).
      emaFast: 24_000,
      emaSlow: 24_000,
      rsi: 55,
      supertrendValue: 24_000,
      atr: 12,
    }), CONFIGURATION);

    expect(ideas).toHaveLength(0);
  });

  it("scores Supertrend headroom rather than assuming it", () => {
    const near = strategy.evaluate(context({ supertrendValue: 24_000 - 1 }), CONFIGURATION);
    const far = strategy.evaluate(context({ supertrendValue: 24_000 - 12 }), CONFIGURATION);

    expect(near).toHaveLength(1);
    expect(far).toHaveLength(1);
    // One ATR of headroom must be worth more than one point of it.
    expect(far[0]!.confidence).toBeGreaterThan(near[0]!.confidence);
  });

  it("reports the base as 0.3 with a separate Supertrend term", () => {
    const ideas = strategy.evaluate(context(), CONFIGURATION);
    const strategyEvidence = ideas[0]!.evidenceItems.find(
      (item) => item.sourceType === "STRATEGY",
    )!;
    const terms = (strategyEvidence.details as { confidenceTerms: Record<string, number> })
      .confidenceTerms;

    expect(terms.base).toBe(0.3);
    expect(terms.supertrendHeadroom).toBeGreaterThan(0);
    // 0.3 + 0.3 + 0.2 + 0.2 must still be able to reach 1.0 and never exceed it.
    const maxed = strategy.evaluate(context({
      emaFast: 24_000 + 60, emaSlow: 24_000, rsi: 65, supertrendValue: 24_000 - 60, atr: 12,
    }), CONFIGURATION);
    expect(maxed[0]!.confidence).toBeLessThanOrEqual(1);
  });
});

describe("MomentumScalpIndexStrategy geometry", () => {
  it("brackets from ATR with the configured reward multiple, on the right side", () => {
    const ideas = strategy.evaluate(context({ atr: 12 }), CONFIGURATION);
    const idea = ideas[0]!;

    // Stop is one ATR below entry; target is 1.5x the realised risk above it.
    expect(idea.stopLoss).toBeLessThan(idea.entryPrice);
    expect(idea.targetPrice).toBeGreaterThan(idea.entryPrice);
    expect(idea.entryPrice - idea.stopLoss).toBeCloseTo(12, 1);
    expect(idea.riskReward).toBeCloseTo(1.5, 1);
  });

  it("inverts the bracket for a SHORT", () => {
    const idea = strategy.evaluate(context({
      trend: "DOWN", emaFast: 23_994, emaSlow: 24_000, rsi: 35, supertrendValue: 24_012,
    }), CONFIGURATION)[0]!;

    expect(idea.stopLoss).toBeGreaterThan(idea.entryPrice);
    expect(idea.targetPrice).toBeLessThan(idea.entryPrice);
  });

  it("expires the idea after the configured number of bars, scaled by timeframe", () => {
    const oneMinute = strategy.evaluate(context({ timeframe: "1m" }), CONFIGURATION)[0]!;
    const fiveMinute = strategy.evaluate(context({ timeframe: "5m" }), CONFIGURATION)[0]!;

    const oneMinuteSpan = oneMinute.expiresAt!.getTime() - context().candle.closeTime.getTime();
    const fiveMinuteSpan = fiveMinute.expiresAt!.getTime() - context().candle.closeTime.getTime();

    expect(oneMinuteSpan).toBe(3 * 60_000);
    expect(fiveMinuteSpan).toBe(5 * 3 * 60_000);
  });

  it("refuses a timeframe it cannot convert to a bar length", () => {
    expect(strategy.evaluate(context({ timeframe: "weekly" }), CONFIGURATION)).toHaveLength(0);
  });
});

describe("parseMomentumScalpIndexStrategyConfiguration", () => {
  it("accepts the shipped default", () => {
    expect(() => parseMomentumScalpIndexStrategyConfiguration(CONFIGURATION)).not.toThrow();
  });

  it("refuses inverted RSI bands rather than silently never firing", () => {
    expect(() => parseMomentumScalpIndexStrategyConfiguration({
      ...CONFIGURATION, rsiLongMin: 75, rsiLongMax: 55,
    })).toThrow(/rsiLongMax/);
    expect(() => parseMomentumScalpIndexStrategyConfiguration({
      ...CONFIGURATION, rsiShortMin: 45, rsiShortMax: 25,
    })).toThrow(/rsiShortMax/);
  });

  it("requires every indicator parameter set the strategy resolves", () => {
    const withoutSupertrend = {
      ...CONFIGURATION,
      indicatorParameters: {
        ...defaultMomentumScalpIndexStrategyConfiguration.indicatorParameters,
        SUPERTREND: undefined,
      },
    };
    expect(() => parseMomentumScalpIndexStrategyConfiguration(withoutSupertrend)).toThrow(/SUPERTREND/);
  });
});
