import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  emaWhipsawDiagnostics,
  scalpResearchExecutionConfiguration,
  scalpResearchEntryProfiles,
  scalpResearchExitProfiles,
  vwapTimeBucketDiagnostics,
  withResearchEmaSnapshots,
} from "./momentum-scalp-research.js";
import { defaultMomentumScalpStrategyConfiguration } from "./momentum-scalp-strategy.js";

function contexts(count = 30): StrategyMarketContext[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.1;
    const openTime = new Date(Date.UTC(2026, 7, 10, 3, 45 + index));
    return {
      candle: {
        id: `candle-${index}`,
        instrumentId: "niftybees",
        timeframe: "1m",
        openTime,
        closeTime: new Date(openTime.getTime() + 60_000),
        open: close - 0.05,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 1_000,
        tickSize: 0.01,
      },
      indicators: [
        { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 9 }, values: { value: close - 0.1 } },
        { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: close - 0.2 } },
        { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 0.2 } },
        { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: close - 0.2 } },
      ],
      patterns: [],
      priceActionEvents: [],
    };
  });
}

describe("momentum scalp research profiles", () => {
  it("keeps production as the control and scopes revised terms to research profiles", () => {
    const profiles = scalpResearchEntryProfiles();
    expect(profiles.map((profile) => profile.name)).toEqual([
      "production-control-ema-3-8",
      "legacy-ema-9-20",
      "revised-entry-ema-5-13",
      "revised-entry-ema-3-8",
    ]);
    // profile[0] must exactly equal the live production defaults.
    expect(profiles[0].configuration).toEqual(defaultMomentumScalpStrategyConfiguration);
    expect(profiles[0].configuration.indicatorParameters.EMA_FAST).toEqual({ period: 3 });
    expect(profiles[0].configuration.indicatorParameters.EMA_SLOW).toEqual({ period: 8 });
    // profile[3] has looser RSI bands for research comparison.
    expect(profiles[3].configuration).toMatchObject({
      rsiLongMin: 55,
      rsiLongMax: 75,
      rsiShortMin: 25,
      rsiShortMax: 45,
      minimumVwapDisplacementAtr: 0.10,
      idealVwapDisplacementAtr: 0.40,
    });
    expect(profiles[3].configuration.indicatorParameters).toMatchObject({
      EMA_FAST: { period: 3 },
      EMA_SLOW: { period: 8 },
    });
  });

  it("compares the three requested stop and target geometries", () => {
    expect(scalpResearchExitProfiles()).toEqual([
      { name: "stop-0.5-atr-target-1.0r", atrStopMultiple: 0.5, rewardRiskMultiple: 1.0 },
      { name: "stop-1.0-atr-target-1.0r", atrStopMultiple: 1.0, rewardRiskMultiple: 1.0 },
      { name: "stop-1.0-atr-target-1.5r", atrStopMultiple: 1.0, rewardRiskMultiple: 1.5 },
    ]);
  });

  it("uses explicit constant-risk, cost, slippage, and margin assumptions", () => {
    expect(scalpResearchExecutionConfiguration({
      initialCapital: 1_000_000,
      feePerOrder: 20,
      slippageBps: 1,
      riskFractionPerTrade: 0.0005,
      marginFraction: 0.2,
    })).toMatchObject({
      initialCapital: 1_000_000,
      feePerOrder: 20,
      slippageBps: 1,
      positionSizing: "CONSTANT_RISK_FRACTION",
      riskFractionPerTrade: 0.0005,
      marginFraction: 0.2,
    });
  });

  it("calculates faster EMAs in memory without replacing production EMA snapshots", () => {
    const enriched = withResearchEmaSnapshots(contexts());
    const latest = enriched.at(-1)!;
    expect(latest.indicators.some((indicator) => indicator.code === "EMA" && indicator.parameters.period === 9)).toBe(true);
    expect(latest.indicators.some((indicator) => indicator.code === "EMA" && indicator.parameters.period === 20)).toBe(true);
    for (const period of [3, 5, 8, 13]) {
      expect(latest.indicators.some((indicator) => indicator.code === "EMA" && indicator.parameters.period === period)).toBe(true);
    }
  });

  it("reports crossover reversals and VWAP displacement by scalp session bucket", () => {
    const enriched = withResearchEmaSnapshots(contexts());
    expect(emaWhipsawDiagnostics(enriched)).toHaveLength(3);
    expect(vwapTimeBucketDiagnostics(enriched)).toEqual([{
      bucket: "09:15-10:00 IST",
      bars: 30,
      medianAbsoluteDisplacementAtr: 1,
      p90AbsoluteDisplacementAtr: 1,
      insideProductionWindow: 30,
      insideProductionWindowPercent: 100,
    }]);
  });
});
