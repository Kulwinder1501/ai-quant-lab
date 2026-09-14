import { describe, expect, it } from "vitest";
import {
  MomentumScalpIndexStrategy,
  defaultMomentumScalpIndexStrategyConfiguration,
} from "../../../strategy-engine/domain/momentum-scalp-index-strategy.js";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import {
  alignedCandidates,
  evaluateSupertrendStudy,
  geometryOf,
} from "./index-supertrend-study.js";

/**
 * The parity suite that makes a parallel implementation safe.
 *
 * A research evaluator that reimplements part of a production strategy is only trustworthy while the
 * two provably agree where they overlap. So the central assertion is not "the study works" but "on
 * Supertrend-aligned bars the study reproduces the production geometry exactly" — drift fails the
 * build instead of quietly biasing a study nobody re-checks.
 */

const configuration = defaultMomentumScalpIndexStrategyConfiguration;

function indicator(code: string, parameters: Record<string, unknown>, values: Record<string, unknown>) {
  return {
    code, algorithmVersion: configuration.indicatorAlgorithmVersion, parameters, values,
  } as unknown as StrategyMarketContext["indicators"][number];
}

/** A 5m index bar with fully-specified indicators, so both evaluators see identical inputs. */
function context(input: {
  close: number; emaFast: number; emaSlow: number; rsi: number;
  supertrend: number; trend: "UP" | "DOWN"; atr: number;
}): StrategyMarketContext {
  const closeTime = new Date("2026-08-21T05:30:00.000Z"); // 11:00 IST
  return {
    candle: {
      id: "candle-1", instrumentId: "instrument-1", timeframe: "5m",
      openTime: new Date(closeTime.getTime() - 5 * 60_000), closeTime,
      open: input.close, high: input.close, low: input.close, close: input.close,
      volume: 1000, tickSize: 0.05,
    },
    indicators: [
      indicator("EMA", configuration.indicatorParameters.EMA_FAST!, { value: input.emaFast }),
      indicator("EMA", configuration.indicatorParameters.EMA_SLOW!, { value: input.emaSlow }),
      indicator("RSI", configuration.indicatorParameters.RSI!, { value: input.rsi }),
      indicator("SUPERTREND", configuration.indicatorParameters.SUPERTREND!, { value: input.supertrend, trend: input.trend }),
      indicator("ATR", configuration.indicatorParameters.ATR!, { value: input.atr }),
    ],
    patterns: [],
    priceActionEvents: [],
  } as unknown as StrategyMarketContext;
}

/** A long setup: fast EMA above slow, RSI inside the long band. */
const longSetup = { close: 24000, emaFast: 24010, emaSlow: 23980, rsi: 62, atr: 40 };

describe("index Supertrend study", () => {
  it("captures the disagreeing arm the production strategy discards", () => {
    // The whole point: Supertrend says DOWN while the EMA/RSI setup is long. Production emits nothing,
    // so this population has never been observable.
    const disagreeing = context({ ...longSetup, supertrend: 24080, trend: "DOWN" });
    expect(new MomentumScalpIndexStrategy().evaluate(disagreeing, { ...configuration } as Record<string, unknown>)).toHaveLength(0);

    const candidates = evaluateSupertrendStudy(disagreeing);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.side).toBe("LONG");
    expect(candidates[0]!.supertrendAligned).toBe(false);
    expect(candidates[0]!.supertrendDirection).toBe("DOWN");
    // Signed headroom: price is below the band on a long, so the disagreement has a magnitude.
    expect(candidates[0]!.supertrendHeadroomAtr).toBeLessThan(0);
  });

  it("reproduces the production geometry exactly on aligned bars", () => {
    // The drift guard. If either side changes how entry/stop/target are computed, this fails.
    const aligned = context({ ...longSetup, supertrend: 23900, trend: "UP" });
    const production = new MomentumScalpIndexStrategy()
      .evaluate(aligned, { ...configuration } as Record<string, unknown>);
    const study = alignedCandidates(evaluateSupertrendStudy(aligned));

    expect(production).toHaveLength(1);
    expect(study).toHaveLength(1);
    expect({
      side: study[0]!.side,
      entryPrice: study[0]!.entryPrice,
      stopLoss: study[0]!.stopLoss,
      targetPrice: study[0]!.targetPrice,
    }).toEqual(geometryOf(production[0]!));
  });

  it("keeps the EMA/RSI trigger as the setup definition", () => {
    // Ungating Supertrend must not turn this into an every-bar sampler — that baseline is the control
    // grid's job, and conflating the two would make the study's control comparison meaningless.
    const noTrigger = context({ ...longSetup, rsi: 50, supertrend: 23900, trend: "UP" });
    expect(evaluateSupertrendStudy(noTrigger)).toHaveLength(0);
  });

  it("records the headroom continuously, including when it is positive and aligned", () => {
    const aligned = context({ ...longSetup, supertrend: 23900, trend: "UP" });
    const candidate = evaluateSupertrendStudy(aligned)[0]!;
    expect(candidate.supertrendAligned).toBe(true);
    // (24000 - 23900) / 40 = 2.5 ATR of headroom.
    expect(candidate.supertrendHeadroomAtr).toBeCloseTo(2.5, 6);
    expect(candidate.emaSpreadAtr).toBeCloseTo(0.75, 6);
  });

  it("returns nothing when an indicator is missing rather than guessing", () => {
    const bare = { ...context({ ...longSetup, supertrend: 23900, trend: "UP" }), indicators: [] } as StrategyMarketContext;
    expect(evaluateSupertrendStudy(bare)).toHaveLength(0);
  });
});
