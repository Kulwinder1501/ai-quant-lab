import { describe, expect, it } from "vitest";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
import { EmaStrengthFilteredStrategy, FreshSetupFilteredStrategy, indicatorValue } from "./entry-filters.js";

/**
 * These filters shipped with no coverage at all, which for the stateful one meant its three
 * load-bearing behaviours -- suppress a repeat, pass a flip, re-arm after a quiet bar -- were the
 * exact three nothing asserted.
 */

function indicator(code: string, period: number, value: number) {
  return { code, parameters: { period }, values: { value } } as unknown as StrategyMarketContext["indicators"][number];
}

function context(
  id: string,
  indicators: StrategyMarketContext["indicators"] = [],
  candle: Partial<StrategyMarketContext["candle"]> = {},
): StrategyMarketContext {
  return {
    candle: {
      id,
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-09-09T09:15:00.000Z"),
      closeTime: new Date("2026-09-09T09:16:00.000Z"),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000,
      tickSize: 0.05,
      ...candle,
    },
    indicators,
    patterns: [],
    priceActionEvents: [],
  };
}

function proposal(side: "LONG" | "SHORT"): ProposedTradeIdea {
  return {
    side,
    entryPrice: 100,
    stopLoss: side === "LONG" ? 99 : 101,
    targetPrice: side === "LONG" ? 102 : 98,
    riskReward: 2,
    confidence: 0.8,
    reasoning: ["test"],
    evidence: {},
    expiresAt: null,
    evidenceItems: [],
  };
}

/** Always proposes the given side, so the filter is the only thing that can drop anything. */
class AlwaysProposes implements StrategyEvaluator {
  constructor(private side: "LONG" | "SHORT" | null) {}
  setSide(side: "LONG" | "SHORT" | null) { this.side = side; }
  evaluate(): ProposedTradeIdea[] { return this.side === null ? [] : [proposal(this.side)]; }
}

const STRONG = [indicator("EMA", 3, 110), indicator("EMA", 8, 100), indicator("ATR", 14, 10)];
const WEAK = [indicator("EMA", 3, 100.5), indicator("EMA", 8, 100), indicator("ATR", 14, 10)];

describe("indicatorValue", () => {
  it("matches on both code and period", () => {
    const ctx = context("c1", [indicator("EMA", 3, 7), indicator("EMA", 8, 9)]);
    expect(indicatorValue(ctx, "EMA", 3)).toBe(7);
    expect(indicatorValue(ctx, "EMA", 8)).toBe(9);
  });

  it("returns null for an absent indicator rather than a default", () => {
    expect(indicatorValue(context("c1", []), "ATR", 14)).toBeNull();
    expect(indicatorValue(context("c1", [indicator("EMA", 3, 7)]), "EMA", 20)).toBeNull();
  });
});

describe("EmaStrengthFilteredStrategy", () => {
  it("admits a bar whose EMA separation clears 15% of ATR", () => {
    // |110 - 100| / 10 = 1.00
    const filtered = new EmaStrengthFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("c1", STRONG), {})).toHaveLength(1);
  });

  it("drops a bar whose separation is below the threshold", () => {
    // |100.5 - 100| / 10 = 0.05
    const filtered = new EmaStrengthFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("c1", WEAK), {})).toEqual([]);
  });

  it("refuses when an input is missing, rather than passing the bar through", () => {
    /*
     * Fail-closed on purpose: a filter that silently admits everything because its indicator is
     * absent reports the UNFILTERED population under the filter's name, which is the failure mode
     * that makes a measurement worse than no measurement.
     */
    const filtered = new EmaStrengthFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("c1", []), {})).toEqual([]);
    expect(filtered.evaluate(context("c1", [indicator("EMA", 3, 110), indicator("EMA", 8, 100)]), {})).toEqual([]);
  });

  it("refuses a non-positive ATR instead of dividing by it", () => {
    const zeroAtr = [indicator("EMA", 3, 110), indicator("EMA", 8, 100), indicator("ATR", 14, 0)];
    const filtered = new EmaStrengthFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("c1", zeroAtr), {})).toEqual([]);
  });

  it("does not consult indicators when the strategy proposed nothing", () => {
    // A quiet bar is not a filtered bar, and must not be reported as one.
    const filtered = new EmaStrengthFilteredStrategy(new AlwaysProposes(null));
    expect(filtered.evaluate(context("c1", []), {})).toEqual([]);
  });
});

describe("FreshSetupFilteredStrategy", () => {
  it("admits the first proposal and suppresses the same-side repeat", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new FreshSetupFilteredStrategy(inner);
    expect(filtered.evaluate(context("c1"), {})).toHaveLength(1);
    expect(filtered.evaluate(context("c2"), {})).toEqual([]);
    expect(filtered.evaluate(context("c3"), {})).toEqual([]);
  });

  it("admits a direction change", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new FreshSetupFilteredStrategy(inner);
    expect(filtered.evaluate(context("c1"), {})).toHaveLength(1);
    inner.setSide("SHORT");
    expect(filtered.evaluate(context("c2"), {})).toHaveLength(1);
  });

  it("re-arms after a bar with no proposal", () => {
    // Otherwise one entry would suppress the rest of the session on that side.
    const inner = new AlwaysProposes("LONG");
    const filtered = new FreshSetupFilteredStrategy(inner);
    expect(filtered.evaluate(context("c1"), {})).toHaveLength(1);
    inner.setSide(null);
    expect(filtered.evaluate(context("c2"), {})).toEqual([]);
    inner.setSide("LONG");
    expect(filtered.evaluate(context("c3"), {})).toHaveLength(1);
  });

  it("keys the memory per series, so two instruments do not suppress each other", () => {
    const filtered = new FreshSetupFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("a1", [], { instrumentId: "instrument-1" }), {})).toHaveLength(1);
    expect(filtered.evaluate(context("b1", [], { instrumentId: "instrument-2" }), {})).toHaveLength(1);
    expect(filtered.evaluate(context("a2", [], { instrumentId: "instrument-1" }), {})).toEqual([]);
  });

  it("keys the memory per timeframe too", () => {
    const filtered = new FreshSetupFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("a1", [], { timeframe: "1m" }), {})).toHaveLength(1);
    expect(filtered.evaluate(context("a2", [], { timeframe: "5m" }), {})).toHaveLength(1);
  });

  it("starts clean per instance, so one run cannot inherit another's memory", () => {
    // The module-level array made this memory process-wide; a fresh instance is the whole fix.
    const inner = new AlwaysProposes("LONG");
    expect(new FreshSetupFilteredStrategy(inner).evaluate(context("c1"), {})).toHaveLength(1);
    expect(new FreshSetupFilteredStrategy(inner).evaluate(context("c1"), {})).toHaveLength(1);
  });
});
