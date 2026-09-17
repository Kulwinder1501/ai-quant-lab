import { describe, expect, it } from "vitest";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
import {
  EmaStrengthFilteredStrategy,
  FreshSetupFilteredStrategy,
  RelativeVolumeFilteredStrategy,
  SmcConfidenceGatedStrategy,
  TimeWindowFilteredStrategy,
  indicatorValue,
  istMinuteOfDay,
} from "./entry-filters.js";

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

describe("istMinuteOfDay", () => {
  it("converts a UTC instant to IST minute-of-day", () => {
    expect(istMinuteOfDay(new Date("2026-09-09T03:45:00.000Z"))).toBe(9 * 60 + 15); // session open
    expect(istMinuteOfDay(new Date("2026-09-09T05:30:00.000Z"))).toBe(11 * 60); // 11:00 IST
    expect(istMinuteOfDay(new Date("2026-09-09T08:00:00.000Z"))).toBe(13 * 60 + 30); // 13:30 IST
  });
});

describe("TimeWindowFilteredStrategy", () => {
  const blockElevenToHalfOne = [{ startMinute: 11 * 60, endMinute: 13 * 60 + 30 }];

  it("admits a bar whose open time falls outside every blocked window", () => {
    const filtered = new TimeWindowFilteredStrategy(new AlwaysProposes("LONG"), blockElevenToHalfOne);
    // 09:15 IST = 03:45 UTC
    const ctx = context("c1", [], { openTime: new Date("2026-09-09T03:45:00.000Z") });
    expect(filtered.evaluate(ctx, {})).toHaveLength(1);
  });

  it("drops a bar whose open time falls inside a blocked window", () => {
    const filtered = new TimeWindowFilteredStrategy(new AlwaysProposes("LONG"), blockElevenToHalfOne);
    // 12:00 IST = 06:30 UTC
    const ctx = context("c1", [], { openTime: new Date("2026-09-09T06:30:00.000Z") });
    expect(filtered.evaluate(ctx, {})).toEqual([]);
  });

  it("treats the window as half-open: start is blocked, end is admitted", () => {
    const filtered = new TimeWindowFilteredStrategy(new AlwaysProposes("LONG"), blockElevenToHalfOne);
    const atStart = context("c1", [], { openTime: new Date("2026-09-09T05:30:00.000Z") }); // 11:00 IST
    const atEnd = context("c2", [], { openTime: new Date("2026-09-09T08:00:00.000Z") }); // 13:30 IST
    expect(filtered.evaluate(atStart, {})).toEqual([]);
    expect(filtered.evaluate(atEnd, {})).toHaveLength(1);
  });

  it("does not consult the clock when the strategy proposed nothing", () => {
    const filtered = new TimeWindowFilteredStrategy(new AlwaysProposes(null), blockElevenToHalfOne);
    const ctx = context("c1", [], { openTime: new Date("2026-09-09T03:45:00.000Z") });
    expect(filtered.evaluate(ctx, {})).toEqual([]);
  });

  it("supports multiple disjoint blocked windows", () => {
    const filtered = new TimeWindowFilteredStrategy(new AlwaysProposes("LONG"), [
      { startMinute: 11 * 60, endMinute: 13 * 60 + 30 },
      { startMinute: 14 * 60 + 45, endMinute: 15 * 60 + 15 },
    ]);
    // 15:00 IST = 09:30 UTC, inside the second window
    const ctx = context("c1", [], { openTime: new Date("2026-09-09T09:30:00.000Z") });
    expect(filtered.evaluate(ctx, {})).toEqual([]);
  });
});

describe("RelativeVolumeFilteredStrategy", () => {
  function feed(filtered: RelativeVolumeFilteredStrategy, inner: AlwaysProposes, volumes: number[]) {
    let last: ProposedTradeIdea[] = [];
    volumes.forEach((volume, index) => {
      last = filtered.evaluate(context(`c${index}`, [], { volume }), {});
    });
    return last;
  }

  it("refuses (fail-closed) before the lookback window is full, even on huge volume", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 20);
    // Only 5 prior bars fed; the 6th, however large, still lacks a 20-bar baseline.
    const result = feed(filtered, inner, [100, 100, 100, 100, 100, 100_000]);
    expect(result).toEqual([]);
  });

  it("admits a bar whose volume clears the multiple of the trailing mean", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 20);
    const baseline = Array(20).fill(100); // mean 100
    const result = feed(filtered, inner, [...baseline, 151]); // 151 >= 1.5 * 100
    expect(result).toHaveLength(1);
  });

  it("drops a bar whose volume falls short of the multiple", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 20);
    const baseline = Array(20).fill(100);
    const result = feed(filtered, inner, [...baseline, 149]); // 149 < 1.5 * 100
    expect(result).toEqual([]);
  });

  it("never includes the signal bar's own volume in its baseline", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 3);
    // Baseline bars: 10, 10, 10 (mean 10). A signal bar of 1,000,000 must not enter its own mean.
    const first = feed(filtered, inner, [10, 10, 10, 1_000_000]);
    expect(first).toHaveLength(1); // 1,000,000 >= 1.5 * 10
    // Next bar's baseline is now [10, 10, 1_000_000] (mean ~333,340), so 20 no longer clears it.
    const second = filtered.evaluate(context("next", [], { volume: 20 }), {});
    expect(second).toEqual([]);
  });

  it("does not consult volume when the strategy proposed nothing, but still records the bar", () => {
    const inner = new AlwaysProposes(null);
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 2);
    expect(filtered.evaluate(context("c1", [], { volume: 100 }), {})).toEqual([]);
    expect(filtered.evaluate(context("c2", [], { volume: 100 }), {})).toEqual([]);
    inner.setSide("LONG");
    // Baseline now has 2 bars (100, 100); a 151-volume bar should clear 1.5x.
    expect(filtered.evaluate(context("c3", [], { volume: 151 }), {})).toHaveLength(1);
  });

  it("keys the rolling baseline per series, so two instruments do not share volume history", () => {
    const inner = new AlwaysProposes("LONG");
    const filtered = new RelativeVolumeFilteredStrategy(inner, 1.5, 1);
    filtered.evaluate(context("a1", [], { volume: 100, instrumentId: "instrument-1" }), {});
    const other = filtered.evaluate(context("b1", [], { volume: 151, instrumentId: "instrument-2" }), {});
    // instrument-2 has no baseline of its own yet, so it must refuse despite instrument-1's history.
    expect(other).toEqual([]);
  });
});

describe("SmcConfidenceGatedStrategy", () => {
  /** Proposes the given side at a caller-chosen confidence, so the floor can be tested precisely. */
  class FixedConfidenceProposes implements StrategyEvaluator {
    constructor(private readonly side: "LONG" | "SHORT", private readonly confidence: number) {}
    evaluate(): ProposedTradeIdea[] {
      return [{ ...proposal(this.side), confidence: this.confidence }];
    }
  }

  const BEARISH_SWEEP: StrategyMarketContext["indicators"] = [{
    code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v2", parameters: {},
    values: { type: "BEARISH_SWEEP", level: 100 },
  }];
  const BULLISH_FVG: StrategyMarketContext["indicators"] = [{
    code: "FVG", algorithmVersion: "smc-v2", parameters: {},
    values: { type: "BULLISH", top: 101, bottom: 100 },
  }];

  it("applies the real SMC adjustment and drops what it pushes below the 0.6 options-entry floor", () => {
    // LIQUIDITY_SWEEP weight 5 -> -0.05 against a LONG. 0.64 - 0.05 = 0.59, below the floor.
    const gated = new SmcConfidenceGatedStrategy(new FixedConfidenceProposes("LONG", 0.64), true);
    expect(gated.evaluate(context("c1", BEARISH_SWEEP), {})).toEqual([]);
  });

  it("does not apply SMC when disabled, so the same signal has no effect on the same proposal", () => {
    const gated = new SmcConfidenceGatedStrategy(new FixedConfidenceProposes("LONG", 0.64), false);
    const result = gated.evaluate(context("c1", BEARISH_SWEEP), {});
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(0.64);
  });

  it("still enforces the confidence floor with SMC disabled, on the base confidence alone", () => {
    const gated = new SmcConfidenceGatedStrategy(new FixedConfidenceProposes("LONG", 0.5), false);
    expect(gated.evaluate(context("c1", []), {})).toEqual([]);
  });

  it("lets a confirming signal rescue a proposal that would otherwise miss the floor, only when enabled", () => {
    // FVG weight 3 -> +0.03 for a LONG. 0.58 + 0.03 = 0.61, clears the floor.
    const withSmc = new SmcConfidenceGatedStrategy(new FixedConfidenceProposes("LONG", 0.58), true);
    const withoutSmc = new SmcConfidenceGatedStrategy(new FixedConfidenceProposes("LONG", 0.58), false);
    expect(withSmc.evaluate(context("c1", BULLISH_FVG), {})).toHaveLength(1);
    expect(withoutSmc.evaluate(context("c1", BULLISH_FVG), {})).toEqual([]);
  });

  it("does not consult SMC when the strategy proposed nothing", () => {
    const gated = new SmcConfidenceGatedStrategy(new AlwaysProposes(null), true);
    expect(gated.evaluate(context("c1", BEARISH_SWEEP), {})).toEqual([]);
  });
});
