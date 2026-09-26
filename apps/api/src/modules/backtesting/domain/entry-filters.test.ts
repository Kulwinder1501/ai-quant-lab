import { describe, expect, it } from "vitest";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
import {
  EmaStrengthFilteredStrategy,
  FreshSetupFilteredStrategy,
  PatternAlignmentFilteredStrategy,
  PatternAnchoredStopStrategy,
  LiquiditySweepAnchoredStopStrategy,
  OrderBlockTargetStrategy,
  LiquiditySweepLookbackStopStrategy,
  OrderBlockLookbackTargetStrategy,
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

describe("PatternAlignmentFilteredStrategy", () => {
  function withPatterns(id: string, patterns: StrategyMarketContext["patterns"]): StrategyMarketContext {
    return { ...context(id), patterns };
  }

  const BULLISH_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "BULLISH_ENGULFING", algorithmVersion: "candlestick-v1", direction: "BULLISH",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];
  const BEARISH_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "BEARISH_ENGULFING", algorithmVersion: "candlestick-v1", direction: "BEARISH",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];
  const NEUTRAL_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "DOJI", algorithmVersion: "candlestick-v1", direction: "NEUTRAL",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];

  it("drops a LONG proposal when a bullish (agreeing) pattern is present", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(withPatterns("c1", BULLISH_PATTERN), {})).toEqual([]);
  });

  it("drops a SHORT proposal when a bearish (agreeing) pattern is present", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("SHORT"));
    expect(filtered.evaluate(withPatterns("c1", BEARISH_PATTERN), {})).toEqual([]);
  });

  it("admits a LONG proposal when the only pattern present disagrees with it", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(withPatterns("c1", BEARISH_PATTERN), {})).toHaveLength(1);
  });

  it("admits a proposal when the only pattern present is neutral", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(withPatterns("c1", NEUTRAL_PATTERN), {})).toHaveLength(1);
  });

  it("admits a proposal when no pattern is present at all", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("LONG"));
    expect(filtered.evaluate(context("c1"), {})).toHaveLength(1);
  });

  it("drops a proposal when any one of several patterns on the bar agrees, even if others disagree", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes("LONG"));
    const mixed = [...BEARISH_PATTERN, ...BULLISH_PATTERN, ...NEUTRAL_PATTERN];
    expect(filtered.evaluate(withPatterns("c1", mixed), {})).toEqual([]);
  });

  it("does not consult patterns when the strategy proposed nothing", () => {
    const filtered = new PatternAlignmentFilteredStrategy(new AlwaysProposes(null));
    expect(filtered.evaluate(withPatterns("c1", BULLISH_PATTERN), {})).toEqual([]);
  });
});

describe("PatternAnchoredStopStrategy", () => {
  function withPatterns(id: string, patterns: StrategyMarketContext["patterns"], candle: Partial<StrategyMarketContext["candle"]> = {}): StrategyMarketContext {
    return { ...context(id, [], candle), patterns };
  }

  const BULLISH_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "BULLISH_ENGULFING", algorithmVersion: "candlestick-v1", direction: "BULLISH",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];
  const BEARISH_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "BEARISH_ENGULFING", algorithmVersion: "candlestick-v1", direction: "BEARISH",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];
  const NEUTRAL_PATTERN: StrategyMarketContext["patterns"] = [{
    code: "DOJI", algorithmVersion: "candlestick-v1", direction: "NEUTRAL",
    confidence: 0.8, contextCandleIds: [], details: {},
  }];

  it("anchors a LONG's stop to the bar's low, one tick beyond it, when a bullish pattern is present", () => {
    // candle: low=99, tickSize=0.05 -> anchored stop 98.95. entryPrice=100, targetPrice=102.
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withPatterns("c1", BULLISH_PATTERN), {});
    expect(result!.stopLoss).toBeCloseTo(98.95);
    expect(result!.riskReward).toBeCloseTo(2 / 1.05); // reward 2, anchored risk 1.05
  });

  it("anchors a SHORT's stop to the bar's high, one tick beyond it, when a bearish pattern is present", () => {
    // candle: high=101, tickSize=0.05 -> anchored stop 101.05. entryPrice=100, targetPrice=98.
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("SHORT"));
    const [result] = anchored.evaluate(withPatterns("c1", BEARISH_PATTERN), {});
    expect(result!.stopLoss).toBeCloseTo(101.05);
    expect(result!.riskReward).toBeCloseTo(2 / 1.05); // reward 2, anchored risk 1.05
  });

  it("overrides even when the anchored stop is wider than the original, matching the proposal as stated", () => {
    // Original LONG stop is 99 (risk 1). A wide bar (low=90) anchors to 89.95 (risk 10.05) -- wider, not tighter.
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withPatterns("c1", BULLISH_PATTERN, { low: 90 }), {});
    expect(result!.stopLoss).toBeCloseTo(89.95);
  });

  it("leaves the proposal untouched when no confluent pattern is present", () => {
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withPatterns("c1", BEARISH_PATTERN), {}); // disagreeing
    expect(result!.stopLoss).toBe(99); // original ATR stop, unchanged
  });

  it("leaves the proposal untouched when the only pattern present is neutral", () => {
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withPatterns("c1", NEUTRAL_PATTERN), {});
    expect(result!.stopLoss).toBe(99);
  });

  it("leaves the proposal untouched when no pattern is present at all", () => {
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(context("c1"), {});
    expect(result!.stopLoss).toBe(99);
  });

  it("fails closed when the anchored level would land on the wrong side of entry", () => {
    // LONG entry=100, but the bar's low (100.5) is above entry -- anchoring there is incoherent.
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withPatterns("c1", BULLISH_PATTERN, { low: 100.5, high: 101.5 }), {});
    expect(result!.stopLoss).toBe(99); // kept the original stop rather than a broken risk leg
  });

  it("does not consult patterns when the strategy proposed nothing", () => {
    const anchored = new PatternAnchoredStopStrategy(new AlwaysProposes(null));
    expect(anchored.evaluate(withPatterns("c1", BULLISH_PATTERN), {})).toEqual([]);
  });
});

describe("LiquiditySweepAnchoredStopStrategy", () => {
  function withIndicators(id: string, indicators: StrategyMarketContext["indicators"]): StrategyMarketContext {
    return context(id, indicators);
  }

  function sweep(type: "BULLISH_SWEEP" | "BEARISH_SWEEP", level: number): StrategyMarketContext["indicators"] {
    return [{ code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v2", parameters: {}, values: { type, level } }];
  }

  it("anchors a LONG's stop below a confirming BULLISH_SWEEP level, one tick beyond it", () => {
    // level=97, tickSize=0.05 -> anchored stop 96.95. entryPrice=100, targetPrice=102.
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withIndicators("c1", sweep("BULLISH_SWEEP", 97)), {});
    expect(result!.stopLoss).toBeCloseTo(96.95);
    expect(result!.riskReward).toBeCloseTo(2 / 3.05);
  });

  it("anchors a SHORT's stop above a confirming BEARISH_SWEEP level, one tick beyond it", () => {
    // level=103, tickSize=0.05 -> anchored stop 103.05. entryPrice=100, targetPrice=98.
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes("SHORT"));
    const [result] = anchored.evaluate(withIndicators("c1", sweep("BEARISH_SWEEP", 103)), {});
    expect(result!.stopLoss).toBeCloseTo(103.05);
    expect(result!.riskReward).toBeCloseTo(2 / 3.05);
  });

  it("leaves the proposal untouched when the only sweep present disagrees with the trade's side", () => {
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withIndicators("c1", sweep("BEARISH_SWEEP", 97)), {});
    expect(result!.stopLoss).toBe(99); // original ATR stop, unchanged
  });

  it("leaves the proposal untouched when no LIQUIDITY_SWEEP is present at all", () => {
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(context("c1"), {});
    expect(result!.stopLoss).toBe(99);
  });

  it("fails closed when the swept level would land on the wrong side of entry", () => {
    // LONG entry=100, but the sweep level (105) is above entry -- anchoring there is incoherent.
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes("LONG"));
    const [result] = anchored.evaluate(withIndicators("c1", sweep("BULLISH_SWEEP", 105)), {});
    expect(result!.stopLoss).toBe(99);
  });

  it("does not consult indicators when the strategy proposed nothing", () => {
    const anchored = new LiquiditySweepAnchoredStopStrategy(new AlwaysProposes(null));
    expect(anchored.evaluate(withIndicators("c1", sweep("BULLISH_SWEEP", 97)), {})).toEqual([]);
  });
});

describe("OrderBlockTargetStrategy", () => {
  function withIndicators(id: string, indicators: StrategyMarketContext["indicators"]): StrategyMarketContext {
    return context(id, indicators);
  }

  function orderBlock(
    type: "BULLISH_OB" | "BEARISH_OB",
    top: number,
    bottom: number,
  ): StrategyMarketContext["indicators"][number] {
    return { code: "ORDER_BLOCK", algorithmVersion: "smc-v2", parameters: {}, values: { type, top, bottom, blockBarOffset: 1 } };
  }

  it("retargets a LONG to the near edge of a BEARISH_OB ahead of price", () => {
    // entry=100, stop=99 (risk 1). Block bottom=105 is ahead -> target 105, reward 5, riskReward 5.
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("LONG"));
    const [result] = retargeted.evaluate(withIndicators("c1", [orderBlock("BEARISH_OB", 110, 105)]), {});
    expect(result!.targetPrice).toBeCloseTo(105);
    expect(result!.riskReward).toBeCloseTo(5);
  });

  it("retargets a SHORT to the near edge of a BULLISH_OB ahead of price", () => {
    // entry=100, stop=101 (risk 1). Block top=95 is ahead -> target 95, reward 5, riskReward 5.
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("SHORT"));
    const [result] = retargeted.evaluate(withIndicators("c1", [orderBlock("BULLISH_OB", 95, 90)]), {});
    expect(result!.targetPrice).toBeCloseTo(95);
    expect(result!.riskReward).toBeCloseTo(5);
  });

  it("picks the nearest of several qualifying blocks", () => {
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("LONG"));
    const [result] = retargeted.evaluate(
      withIndicators("c1", [orderBlock("BEARISH_OB", 130, 120), orderBlock("BEARISH_OB", 108, 103)]),
      {},
    );
    expect(result!.targetPrice).toBeCloseTo(103);
  });

  it("leaves the proposal untouched when the only block present is behind price, not ahead", () => {
    // A BEARISH_OB whose bottom (95) sits below a LONG's entry (100) is not a target ahead of price.
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("LONG"));
    const [result] = retargeted.evaluate(withIndicators("c1", [orderBlock("BEARISH_OB", 98, 95)]), {});
    expect(result!.targetPrice).toBe(102); // original R:R target, unchanged
  });

  it("leaves the proposal untouched when the only block present is the wrong (agreeing) type", () => {
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("LONG"));
    const [result] = retargeted.evaluate(withIndicators("c1", [orderBlock("BULLISH_OB", 110, 105)]), {});
    expect(result!.targetPrice).toBe(102);
  });

  it("leaves the proposal untouched when no ORDER_BLOCK is present at all", () => {
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes("LONG"));
    const [result] = retargeted.evaluate(context("c1"), {});
    expect(result!.targetPrice).toBe(102);
  });

  it("does not consult indicators when the strategy proposed nothing", () => {
    const retargeted = new OrderBlockTargetStrategy(new AlwaysProposes(null));
    expect(retargeted.evaluate(withIndicators("c1", [orderBlock("BEARISH_OB", 110, 105)]), {})).toEqual([]);
  });
});

describe("LiquiditySweepLookbackStopStrategy", () => {
  function sweep(type: "BULLISH_SWEEP" | "BEARISH_SWEEP", level: number): StrategyMarketContext["indicators"] {
    return [{ code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v2", parameters: {}, values: { type, level } }];
  }

  it("anchors to a confirming sweep seen several bars before the proposal, within the lookback", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 5);
    anchored.evaluate(context("c1", sweep("BULLISH_SWEEP", 97)), {}); // sweep, no proposal yet
    anchored.evaluate(context("c2"), {});
    anchored.evaluate(context("c3"), {});
    inner.setSide("LONG");
    const [result] = anchored.evaluate(context("c4"), {}); // 3 bars after the sweep, still within lookback=5
    expect(result!.stopLoss).toBeCloseTo(96.95);
  });

  it("evicts a sweep older than the lookback window", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 2);
    anchored.evaluate(context("c1", sweep("BULLISH_SWEEP", 97)), {});
    anchored.evaluate(context("c2"), {});
    anchored.evaluate(context("c3"), {}); // buffer (lookback=2) no longer contains c1's sweep
    inner.setSide("LONG");
    const [result] = anchored.evaluate(context("c4"), {});
    expect(result!.stopLoss).toBe(99); // original ATR stop, sweep fell out of the window
  });

  it("uses the most recent of several confirming sweeps in the buffer", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 5);
    anchored.evaluate(context("c1", sweep("BULLISH_SWEEP", 97)), {});
    anchored.evaluate(context("c2", sweep("BULLISH_SWEEP", 95)), {}); // more recent
    inner.setSide("LONG");
    const [result] = anchored.evaluate(context("c3"), {});
    expect(result!.stopLoss).toBeCloseTo(94.95); // anchored to 95, not 97
  });

  it("ignores a sweep whose direction disagrees with the trade's side", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 5);
    anchored.evaluate(context("c1", sweep("BEARISH_SWEEP", 97)), {});
    inner.setSide("LONG");
    const [result] = anchored.evaluate(context("c2"), {});
    expect(result!.stopLoss).toBe(99);
  });

  it("keys the buffer per series, so two instruments do not share sweeps", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 5);
    anchored.evaluate(context("a1", sweep("BULLISH_SWEEP", 97), { instrumentId: "instrument-1" }), {});
    inner.setSide("LONG");
    const [other] = anchored.evaluate(context("b1", [], { instrumentId: "instrument-2" }), {});
    expect(other!.stopLoss).toBe(99); // instrument-2 has no sweep history of its own
  });

  it("does not consult the buffer when the strategy proposed nothing, but still records the bar", () => {
    const inner = new AlwaysProposes(null);
    const anchored = new LiquiditySweepLookbackStopStrategy(inner, 5);
    expect(anchored.evaluate(context("c1", sweep("BULLISH_SWEEP", 97)), {})).toEqual([]);
  });
});

describe("OrderBlockLookbackTargetStrategy", () => {
  function orderBlock(
    type: "BULLISH_OB" | "BEARISH_OB",
    top: number,
    bottom: number,
  ): StrategyMarketContext["indicators"][number] {
    return { code: "ORDER_BLOCK", algorithmVersion: "smc-v2", parameters: {}, values: { type, top, bottom, blockBarOffset: 1 } };
  }

  it("retargets to a qualifying block seen several bars before the proposal, within the lookback", () => {
    const inner = new AlwaysProposes(null);
    const retargeted = new OrderBlockLookbackTargetStrategy(inner, 5);
    retargeted.evaluate(context("c1", [orderBlock("BEARISH_OB", 110, 105)]), {});
    retargeted.evaluate(context("c2"), {});
    inner.setSide("LONG");
    const [result] = retargeted.evaluate(context("c3"), {});
    expect(result!.targetPrice).toBeCloseTo(105);
  });

  it("evicts a block older than the lookback window", () => {
    const inner = new AlwaysProposes(null);
    const retargeted = new OrderBlockLookbackTargetStrategy(inner, 1);
    retargeted.evaluate(context("c1", [orderBlock("BEARISH_OB", 110, 105)]), {});
    retargeted.evaluate(context("c2"), {}); // lookback=1: c1's block already evicted
    inner.setSide("LONG");
    const [result] = retargeted.evaluate(context("c3"), {});
    expect(result!.targetPrice).toBe(102); // original R:R target
  });

  it("picks the nearest of several qualifying blocks across the buffer, not just the most recent", () => {
    const inner = new AlwaysProposes(null);
    const retargeted = new OrderBlockLookbackTargetStrategy(inner, 5);
    retargeted.evaluate(context("c1", [orderBlock("BEARISH_OB", 108, 103)]), {}); // nearer
    retargeted.evaluate(context("c2", [orderBlock("BEARISH_OB", 130, 120)]), {}); // farther, more recent
    inner.setSide("LONG");
    const [result] = retargeted.evaluate(context("c3"), {});
    expect(result!.targetPrice).toBeCloseTo(103);
  });

  it("keys the buffer per series, so two instruments do not share blocks", () => {
    const inner = new AlwaysProposes(null);
    const retargeted = new OrderBlockLookbackTargetStrategy(inner, 5);
    retargeted.evaluate(context("a1", [orderBlock("BEARISH_OB", 110, 105)], { instrumentId: "instrument-1" }), {});
    inner.setSide("LONG");
    const [other] = retargeted.evaluate(context("b1", [], { instrumentId: "instrument-2" }), {});
    expect(other!.targetPrice).toBe(102);
  });

  it("does not consult the buffer when the strategy proposed nothing, but still records the bar", () => {
    const inner = new AlwaysProposes(null);
    const retargeted = new OrderBlockLookbackTargetStrategy(inner, 5);
    expect(retargeted.evaluate(context("c1", [orderBlock("BEARISH_OB", 110, 105)]), {})).toEqual([]);
  });
});
