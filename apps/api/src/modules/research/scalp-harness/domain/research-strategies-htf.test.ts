import { describe, expect, it } from "vitest";
import { researchScalpStrategies } from "./research-strategies.js";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";

/**
 * The V6 adapter actually merges HTF covariates onto a real proposal, and V5 does not.
 *
 * This is the load-bearing wiring: if the extender were never called, V6 would capture nothing
 * beyond V5 and the whole version would be inert -- the same empty-layer trap the harness exists to
 * avoid. So this drives a real qualifying 1m setup through the shipped adapters and reads the
 * proposal each one produces.
 */

// 10:00 IST, a whole-minute on-grid decision (GRID_POLICY_V1), so buildProposal accepts it.
const decisionAt = new Date("2026-08-21T04:30:00.000Z");

function qualifyingLong(htf?: StrategyMarketContext): StrategyMarketContext {
  const close = 1006;
  return {
    candle: {
      id: "candle-1m", instrumentId: "instrument-1", timeframe: "1m",
      openTime: new Date(decisionAt.getTime() - 60_000), closeTime: decisionAt,
      open: close - 1, high: close + 0.5, low: close - 1.5, close, volume: 100_000, tickSize: 0.05,
    },
    // The same separation / displacement / RSI band that momentum-scalp-strategy.test.ts uses to
    // trigger a LONG. Under the research floor of minimumConfidence: 0 it always emits.
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 1005 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 1000 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 65 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 1000 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 10 } },
    ],
    patterns: [],
    priceActionEvents: [],
    ...(htf ? { higherTimeframeContexts: { "5m": htf } } : {}),
  };
}

function htf5m(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-5m", instrumentId: "instrument-1", timeframe: "5m",
      openTime: new Date(decisionAt.getTime() - 5 * 60_000), closeTime: decisionAt,
      open: 1000, high: 1008, low: 998, close: 1004, volume: 500_000, tickSize: 0.05,
    },
    indicators: [
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 58 } },
    ],
    patterns: [],
    priceActionEvents: [],
  };
}

const v5 = researchScalpStrategies.find((s) => s.definition.strategyKey === "momentum-v5-research")!;
const v6 = researchScalpStrategies.find((s) => s.definition.strategyKey === "momentum-v6-research")!;

describe("momentum-v6-research HTF capture", () => {
  it("v5 records no htf5m block; v6 records one even when no 5m context is attached", () => {
    const ctx = qualifyingLong();
    const [p5] = v5.evaluate(ctx, ctx);
    const [p6] = v6.evaluate(ctx, ctx);
    expect(p5).toBeDefined();
    expect(p6).toBeDefined();
    expect(p5!.rawContext.htf5m).toBeUndefined();
    // present:false, not an omitted key -- proof the extender ran, and that absence is recorded.
    expect((p6!.rawContext.htf5m as { present: boolean }).present).toBe(false);
  });

  it("v6 records the attached 5m slice losslessly", () => {
    const ctx = qualifyingLong(htf5m());
    const [p6] = v6.evaluate(ctx, ctx);
    const block = p6!.rawContext.htf5m as { present: boolean; candle: { close: number }; indicators: unknown[] };
    expect(block.present).toBe(true);
    expect(block.candle.close).toBe(1004);
    expect(block.indicators).toHaveLength(1);
  });

  it("v6 is the same setup as v5 but a distinct proposal", () => {
    const ctx = qualifyingLong(htf5m());
    const [p5] = v5.evaluate(ctx, ctx);
    const [p6] = v6.evaluate(ctx, ctx);
    expect(p6!.direction).toBe(p5!.direction);
    expect(p6!.setupType).toBe(p5!.setupType);
    // Distinct definition hash and HTF-enriched rawContext => distinct identity and payload, so the
    // two cohorts never collide in the store.
    expect(p6!.strategyDefinitionHash).not.toBe(p5!.strategyDefinitionHash);
    expect(p6!.proposalKey).not.toBe(p5!.proposalKey);
    expect(p6!.payloadHash).not.toBe(p5!.payloadHash);
  });
});
