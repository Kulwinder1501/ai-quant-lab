import { describe, expect, it } from "vitest";
import { measureTier, type TierStrategyLike } from "./tier-measurement.js";
import type { ProposedTradeIdea, StrategyMarketContext, TradeSide } from "./strategy.js";

/*
 * Every outcome here is resolved by a gap at the next bar's open, because `paper-trade-exit-policy`
 * fills a gap deterministically at that open regardless of the bar's high/low. That removes
 * intrabar ambiguity from the fixtures, so each expected hit rate and R multiple is hand-derived
 * rather than traced through the barrier logic (which `bracket-outcome.test.ts` already covers).
 */

interface BarSpec {
  id: string;
  close: number;
  /** The open that resolves the *previous* bar's bracket when this bar is the forward window. */
  open: number;
  atr: number | null;
  /** Minutes past a fixed base time; used only to place a bar in a session (its date). */
  dayIso: string;
}

function context(spec: BarSpec): StrategyMarketContext {
  const high = Math.max(spec.open, spec.close) + 1;
  const low = Math.min(spec.open, spec.close) - 1;
  const indicators = spec.atr === null
    ? []
    : [{ code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: spec.atr } }];
  return {
    candle: {
      id: spec.id,
      instrumentId: "inst-1",
      timeframe: "1m",
      openTime: new Date(`${spec.dayIso}T04:00:00.000Z`),
      closeTime: new Date(`${spec.dayIso}T04:01:00.000Z`),
      open: spec.open, high, low, close: spec.close,
      volume: 0,
      tickSize: 0.05,
    },
    indicators,
    patterns: [],
    priceActionEvents: [],
    regime: null,
  } as unknown as StrategyMarketContext;
}

/** A LONG bracket at close +/- 10 points (risk 10, reward 10 -> 1:1). */
function longIdea(candle: StrategyMarketContext["candle"]): ProposedTradeIdea {
  return {
    strategyKey: "fake",
    side: "LONG" as TradeSide,
    entryPrice: candle.close,
    stopLoss: candle.close - 10,
    targetPrice: candle.close + 10,
    riskReward: 1,
    confidence: 0.9,
    sourceCandleId: candle.id,
    evidenceItems: [],
    expiresAt: null,
  } as unknown as ProposedTradeIdea;
}

/** Fires a LONG only on the named candles, so which bars signal is exact. */
function fakeStrategy(fireOn: readonly string[]): TierStrategyLike {
  const set = new Set(fireOn);
  return {
    evaluate(ctx: StrategyMarketContext): ProposedTradeIdea[] {
      return set.has(ctx.candle.id) ? [longIdea(ctx.candle)] : [];
    },
  };
}

/*
 * Four bars, all closing at 100, horizon 1 so each bar's forward window is exactly the next bar.
 * Scored bars are 0,1,2 (bar 3 is forward-only). The next-bar opens make each signal deterministic:
 *   bar0 -> bar1.open 110 -> LONG target, +1R
 *   bar1 -> bar2.open  90 -> LONG stop,   -1R
 *   bar2 -> bar3.open 110 -> LONG target, +1R
 */
const BARS: BarSpec[] = [
  { id: "b0", close: 100, open: 100, atr: 10, dayIso: "2026-08-03" },
  { id: "b1", close: 100, open: 110, atr: 10, dayIso: "2026-08-03" },
  { id: "b2", close: 100, open: 90, atr: 10, dayIso: "2026-08-03" },
  { id: "b3", close: 100, open: 110, atr: 10, dayIso: "2026-08-03" },
];

function run(fireOn: readonly string[], overrides: Partial<BarSpec>[] = []) {
  const bars = BARS.map((bar, index) => ({ ...bar, ...(overrides[index] ?? {}) }));
  return measureTier({
    contexts: bars.map(context),
    strategy: fakeStrategy(fireOn),
    configuration: {},
    horizonBars: 1,
    atrStopMultiple: 1,
    rewardRiskMultiple: 1,
  });
}

describe("measureTier", () => {
  it("resolves each signal by the next bar's gap and reports the R it earned", () => {
    const result = run(["b0", "b1", "b2"]);

    expect(result.gated.LONG.signals).toBe(3);
    expect(result.gated.LONG.resolved).toBe(3);
    expect(result.gated.LONG.targets).toBe(2);
    // hits: b0 +1, b1 -1, b2 +1  ->  2/3 hit, mean R 0.3333.
    expect(result.gated.LONG.hitRate).toBeCloseTo(0.6667, 3);
    expect(result.gated.LONG.expectancyR).toBeCloseTo(0.3333, 3);
    expect(result.gated.SHORT.signals).toBe(0);
  });

  it("excludes the final horizon bars, which have no forward window", () => {
    // Fires on every bar, but only 0,1,2 are scored -- bar 3 is forward-only.
    const result = run(["b0", "b1", "b2", "b3"]);
    expect(result.barsScored).toBe(3);
    expect(result.gated.LONG.signals).toBe(3);
  });

  it("builds the unconditional baseline on both sides at every scored bar", () => {
    const result = run([]);
    // No strategy signals, but the baseline fires LONG and SHORT on each of 3 scored bars.
    expect(result.gated.LONG.signals).toBe(0);
    expect(result.unconditional.LONG.signals).toBe(3);
    expect(result.unconditional.SHORT.signals).toBe(3);
    // Same three next-bar opens: baseline LONG mirrors the gated result, SHORT is its inverse.
    expect(result.unconditional.LONG.hitRate).toBeCloseTo(0.6667, 3);
    expect(result.unconditional.SHORT.hitRate).toBeCloseTo(0.3333, 3);
  });

  it("counts bars with no production ATR as skipped, and builds no baseline there", () => {
    const result = run([], [{}, { atr: null }, {}, {}]);
    expect(result.skippedNoAtr).toBe(1);
    // Baseline builds on the two scored bars that still have ATR (b0, b2).
    expect(result.unconditional.LONG.signals).toBe(2);
  });

  it("reports signals per session across distinct dates", () => {
    const result = run(["b0", "b1", "b2"], [
      {}, {}, { dayIso: "2026-08-04" }, { dayIso: "2026-08-04" },
    ]);
    // b0,b1 on the 3rd; b2 on the 4th -> 2 sessions, 3 gated signals.
    expect(result.sessions).toBe(2);
    expect(result.signalsPerSession).toBeCloseTo(1.5, 3);
  });

  it("reports break-even from the reward multiple", () => {
    // rewardRiskMultiple 1 -> 1/(1+1) = 0.5.
    expect(run([]).breakEvenHitRate).toBeCloseTo(0.5, 6);
  });
});

describe("measureTier verdict", () => {
  it("calls a tier worth deploying when it clears break-even and beats its baseline", () => {
    // Fire only on the two winners: gated LONG hit rate 1.0 vs baseline 0.6667 vs break-even 0.5.
    const result = run(["b0", "b2"]);
    expect(result.gated.LONG.hitRate).toBeCloseTo(1, 6);
    expect(result.verdict).toMatch(/LONG: clears break-even and beats its baseline/);
    expect(result.verdict).toMatch(/Worth deploying/);
  });

  it("flags the geometry, not the selection, when a tier only matches its baseline", () => {
    // Firing on every bar reproduces the baseline exactly: same hit rate, no edge from selection.
    const result = run(["b0", "b1", "b2"]);
    expect(result.gated.LONG.hitRate).toBeCloseTo(result.unconditional.LONG.hitRate!, 6);
    expect(result.verdict).toMatch(/the geometry is carrying it, not the selection/);
  });

  it("flags a tier that loses before costs", () => {
    // Fire only on the loser: hit rate 0, below the 0.5 break-even.
    const result = run(["b1"]);
    expect(result.gated.LONG.hitRate).toBe(0);
    expect(result.verdict).toMatch(/LONG: below break-even/);
    expect(result.verdict).toMatch(/Loses before costs/);
  });

  it("says nothing was measured when a side produced no resolved signals", () => {
    const result = run([]);
    expect(result.verdict).toMatch(/LONG: no resolved signals/);
  });
});
