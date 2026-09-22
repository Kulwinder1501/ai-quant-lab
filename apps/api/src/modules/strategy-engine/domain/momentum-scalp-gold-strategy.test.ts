import { describe, expect, it } from "vitest";
import {
  defaultMomentumScalpGoldStrategyConfiguration,
  MomentumScalpGoldStrategy,
} from "./momentum-scalp-gold-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";

const CONFIGURATION = { ...defaultMomentumScalpGoldStrategyConfiguration } as Record<string, unknown>;

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
  const close = options.close ?? 4_300;
  const parameters = defaultMomentumScalpGoldStrategyConfiguration.indicatorParameters;
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
      openTime: new Date("2026-09-22T04:00:00.000Z"),
      closeTime: new Date("2026-09-22T04:01:00.000Z"),
      open: close, high: close + 2, low: close - 2, close,
      volume: 0,
      tickSize: options.tickSize ?? 0.01,
    },
    indicators: [
      snapshot("EMA", parameters.EMA_FAST!, { value: options.emaFast ?? close + 3 }),
      snapshot("EMA", parameters.EMA_SLOW!, { value: options.emaSlow ?? close }),
      snapshot("RSI", parameters.RSI!, { value: options.rsi ?? 65 }),
      snapshot("SUPERTREND", parameters.SUPERTREND!, {
        trend: options.trend ?? "UP",
        value: options.supertrendValue ?? close - 6,
      }),
      snapshot("ATR", parameters.ATR!, { value: options.atr ?? 6 }),
    ],
    patterns: [],
    priceActionEvents: [],
    regime: null,
  } as unknown as StrategyMarketContext;
}

const strategy = new MomentumScalpGoldStrategy();

describe("MomentumScalpGoldStrategy direction gate", () => {
  it("raises a LONG when Supertrend is UP, fast EMA leads and RSI is in band", () => {
    const ideas = strategy.evaluate(context(), CONFIGURATION);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.side).toBe("LONG");
    expect(ideas[0]!.evidence.strategy).toBe("momentum-scalp-gold");
  });

  it("raises a SHORT on the mirrored evidence", () => {
    const ideas = strategy.evaluate(context({
      trend: "DOWN",
      emaFast: 4_297,
      emaSlow: 4_300,
      rsi: 35,
      supertrendValue: 4_306,
    }), CONFIGURATION);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.side).toBe("SHORT");
  });

  it("raises nothing when Supertrend disagrees with the EMA order", () => {
    expect(strategy.evaluate(context({ trend: "DOWN" }), CONFIGURATION)).toHaveLength(0);
  });

  it("raises nothing when RSI sits outside the momentum band", () => {
    expect(strategy.evaluate(context({ rsi: 90 }), CONFIGURATION)).toHaveLength(0);
  });

  it("computes stop/target purely from tickSize and ATR, with no session dependency", () => {
    const ideas = strategy.evaluate(context({ tickSize: 0.1, atr: 8 }), CONFIGURATION);
    expect(ideas).toHaveLength(1);
    const idea = ideas[0]!;
    expect(idea.entryPrice).toBeCloseTo(4_300, 5);
    expect(idea.stopLoss).toBeCloseTo(4_300 - 8, 5);
    expect(idea.targetPrice).toBeCloseTo(4_300 + 8 * defaultMomentumScalpGoldStrategyConfiguration.rewardRiskMultiple, 5);
  });
});
