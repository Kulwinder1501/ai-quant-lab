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
 * ATR is 10, so one ATR of VWAP displacement is 10 points. Close sits 6 points
 * above VWAP, which is 0.6 ATR — the configured ideal displacement.
 */
function qualifyingLongContext(overrides: {
  close?: number;
  vwap?: number;
  rsi?: number;
  emaFast?: number;
  emaSlow?: number;
  timeframe?: string;
} = {}): StrategyMarketContext {
  const close = overrides.close ?? 1006;
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
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: overrides.emaFast ?? 1005 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: overrides.emaSlow ?? 1000 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: overrides.rsi ?? 65 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: overrides.vwap ?? 1000 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 10 } },
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
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 995 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 1000 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 35 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 1000 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 10 } },
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

  it("keeps the production v6 terms unchanged", () => {
    expect(defaultMomentumScalpStrategyConfiguration).toMatchObject({
      rsiLongMin: 55,
      rsiLongMax: 75,
      rsiShortMin: 25,
      rsiShortMax: 45,
      // V5 restores v3's geometry, withdrawing v4.
      //
      // V4's argument was not baseless -- a 1.0x ATR stop is narrower than BANKNIFTY's observed
      // 5-second jump size, so noise can resolve it rather than the thesis. It simply did not
      // survive contact: on its only live session (2026-09-08) all eleven entries stopped out
      // anyway, so the wider stop bought no survival and only enlarged each loss. The promotion
      // rested on seven summed monthly windows with no trade counts and no clustered standard
      // error, which is not enough to move live geometry.
      //
      // 1.5R also keeps the strategy inside the `reward/risk <= 1.6` MOMENTUM_STALL gate in
      // evaluate-open-paper-trades.ts. v4's 2.0R put every trade outside it, silently exempting
      // the strategy from its time stop (17/17 v3 trades eligible, 0/11 v4 trades).
      atrStopMultiple: 1.0,
      rewardRiskMultiple: 1.5,
      minimumVwapDisplacementAtr: 0.10,
      idealVwapDisplacementAtr: 0.60,
      // V6's gate, pinned including its two escape hatches. 15m is the default because it is the
      // timeframe that binds: over the 28 closed 1m trades to 2026-09-08 it blocked 12, while 5m
      // blocked 2 and was effectively inert against a trigger that already checks VWAP and EMA.
      // ALLOW-on-missing is pinned because BLOCK would remove the pre-09:30 window along with the
      // chop, and because a gate failing closed on an unpopulated input has cost this project a
      // silent no-trade session before.
      htfConfluenceMode: "REQUIRE_AGREEMENT",
      htfConfluenceTimeframe: "15m",
      htfConfluenceEmaPeriod: 20,
      htfConfluenceOnMissing: "ALLOW",
    });
    expect(defaultMomentumScalpStrategyConfiguration.indicatorParameters.EMA_FAST).toEqual({ period: 3 });
    expect(defaultMomentumScalpStrategyConfiguration.indicatorParameters.EMA_SLOW).toEqual({ period: 8 });
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
    // 0.01 ATR of displacement is below minimumVwapDisplacementAtr (0.10).
    const context = qualifyingLongContext({ close: 1000.1 });
    expect(new MomentumScalpStrategy().evaluate(context, configuration())).toHaveLength(0);
  });

  it("rejects an already-extended move rather than chasing it", () => {
    // 3 ATR above VWAP, past maximumVwapDisplacementAtr (2.5).
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

/*
 * The higher-timeframe confluence gate.
 *
 * These pin behaviour, and one of them pins a *non*-behaviour: the default configuration must keep
 * firing when no slower context is attached. Production attaches 15m only where the repository can
 * supply it, and every existing caller and stub supplies none, so a gate that blocked on absence
 * would have silently stopped the strategy trading rather than filtering it.
 */
describe("MomentumScalpStrategy higher-timeframe confluence", () => {
  function htfContext(close: number, ema20: number): StrategyMarketContext {
    return {
      candle: {
        id: "candle-htf",
        instrumentId: "instrument-1",
        timeframe: "15m",
        openTime: new Date("2026-07-29T04:45:00.000Z"),
        closeTime: new Date("2026-07-29T05:00:00.000Z"),
        open: close, high: close, low: close, close,
        volume: 100_000,
        tickSize: 0.05,
      },
      indicators: [
        { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: ema20 } },
      ],
      patterns: [],
      priceActionEvents: [],
    };
  }

  function withHtf(base: StrategyMarketContext, htf: StrategyMarketContext | null): StrategyMarketContext {
    return htf ? { ...base, higherTimeframeContexts: { "15m": htf } } : base;
  }

  const config = defaultMomentumScalpStrategyConfiguration as unknown as Record<string, unknown>;

  it("admits a long when the 15m bar is above its EMA20", () => {
    // Close 1010 over EMA20 1000 is BULLISH, which agrees with a LONG.
    const context = withHtf(qualifyingLongContext(), htfContext(1010, 1000));

    const proposals = new MomentumScalpStrategy().evaluate(context, config);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.side).toBe("LONG");
    expect(proposals[0]!.evidenceItems.find((item) => item.sourceReference === "HTF:15m")?.details)
      .toMatchObject({ status: "RESOLVED", bias: "BULLISH", timeframe: "15m", emaPeriod: 20 });
  });

  it("vetoes a long when the 15m bar is below its EMA20", () => {
    const context = withHtf(qualifyingLongContext(), htfContext(990, 1000));

    expect(new MomentumScalpStrategy().evaluate(context, config)).toEqual([]);
  });

  it("vetoes a short when the 15m bar disagrees, so the veto is not long-only", () => {
    const context = withHtf(qualifyingShortContext(), htfContext(1010, 1000));

    expect(new MomentumScalpStrategy().evaluate(context, config)).toEqual([]);
  });

  it("admits a short when the 15m bar is bearish", () => {
    const context = withHtf(qualifyingShortContext(), htfContext(990, 1000));
    const proposals = new MomentumScalpStrategy().evaluate(context, config);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.side).toBe("SHORT");
  });

  it("still fires with no slower context attached, under the ALLOW default", () => {
    // The regression this exists to catch: every current caller attaches nothing, so BLOCK-on-
    // missing would read as "no setups found" rather than as a gate doing its job.
    const proposals = new MomentumScalpStrategy().evaluate(qualifyingLongContext(), config);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.evidenceItems.find((item) => item.sourceReference === "HTF:15m")?.details)
      .toMatchObject({ status: "UNAVAILABLE", onMissing: "ALLOW" });
  });

  it("blocks on a missing slower context when configured to", () => {
    const proposals = new MomentumScalpStrategy()
      .evaluate(qualifyingLongContext(), { ...config, htfConfluenceOnMissing: "BLOCK" });

    expect(proposals).toEqual([]);
  });

  it("restores exactly the ungated behaviour when the mode is OFF", () => {
    // Reversibility without a deploy is the point of the mode, so it is pinned: a disagreeing 15m
    // bar must not veto anything once the gate is off.
    const context = withHtf(qualifyingLongContext(), htfContext(990, 1000));

    const proposals = new MomentumScalpStrategy().evaluate(context, { ...config, htfConfluenceMode: "OFF" });

    expect(proposals).toHaveLength(1);
    // And no HTF evidence is recorded, because nothing was consulted.
    expect(proposals[0]!.evidenceItems.some((item) => item.sourceReference === "HTF:15m")).toBe(false);
  });

  it("blocks unconditionally when the configured timeframe is not strictly higher", () => {
    // A misconfiguration, not missing data -- so `htfConfluenceOnMissing: "ALLOW"` must not rescue
    // it. Otherwise a typo silently produces an ungated strategy that looks gated.
    const context = withHtf(qualifyingLongContext(), htfContext(1010, 1000));

    const proposals = new MomentumScalpStrategy()
      .evaluate(context, { ...config, htfConfluenceTimeframe: "1m", htfConfluenceOnMissing: "ALLOW" });

    expect(proposals).toEqual([]);
  });

  it("treats a slower bar with no matching EMA as unavailable rather than as agreement", () => {
    const htf = htfContext(1010, 1000);
    const noEma: StrategyMarketContext = { ...htf, indicators: [] };
    const context = withHtf(qualifyingLongContext(), noEma);

    expect(new MomentumScalpStrategy().evaluate(context, { ...config, htfConfluenceOnMissing: "BLOCK" }))
      .toEqual([]);
  });

  it("rejects a configuration whose mode is not one of the two spellings", () => {
    expect(() => parseMomentumScalpStrategyConfiguration({ ...config, htfConfluenceMode: "ON" }))
      .toThrow(/htfConfluenceMode to be one of OFF, REQUIRE_AGREEMENT/);
  });
});
