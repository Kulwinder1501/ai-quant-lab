import { describe, expect, it } from "vitest";
import {
  atrPeriod,
  calculateAtrSeries,
  calculateEmaSeries,
  calculateNormalizedSlope,
  calculatePatternContext,
  calculatePatternGeometry,
  calculateVolumeMultiplier,
  calculateVolumeZScore,
  calculateZScore,
  determineTrendState,
  minimumClosedBarsForEmission,
  PatternWarmupError,
} from "./pattern-context-calculator.js";
import { sessionSegmentOf } from "./session-windows.js";

describe("pattern-context-calculator", () => {
  it("calculates Wilder ATR correctly with warmup nulls", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      openTime: new Date(Date.UTC(2026, 7, 25, 4, i)),
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 1000,
    }));
    const atrs = calculateAtrSeries(candles, 14);
    expect(atrs[0]).toBeNull();
    expect(atrs[12]).toBeNull();
    expect(atrs[13]).toBeCloseTo(10, 4); // each candle high-low = 10
    expect(atrs[14]).toBeCloseTo(10, 4);
  });

  it("calculates EMA series correctly with warmup nulls", () => {
    const values = Array.from({ length: 25 }, () => 100);
    const emas = calculateEmaSeries(values, 20);
    expect(emas[18]).toBeNull();
    expect(emas[19]).toBe(100);
    expect(emas[24]).toBe(100);
  });

  it("calculates rolling z-scores and handles zero stddev", () => {
    const constantValues = Array.from({ length: 20 }, () => 50);
    expect(calculateZScore(constantValues, 20)).toBeNull();

    const variedValues = Array.from({ length: 20 }, (_, i) => 10 + i * 2);
    const z = calculateZScore(variedValues, 20);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(1.0); // latest is highest
  });

  it("evaluates trend state precedence strictly", () => {
    // 1. UNKNOWN if < 20 bars
    expect(determineTrendState({ normalizedSlope: 0.1, signChangedInLast2Bars: false, availableBars: 10 })).toBe("UNKNOWN");

    // 2. TRANSITIONING if sign changed in last 2 bars and abs(slope) >= 0.05
    expect(determineTrendState({ normalizedSlope: 0.08, signChangedInLast2Bars: true, availableBars: 25 })).toBe("TRANSITIONING");

    // 3. UP if slope >= 0.05
    expect(determineTrendState({ normalizedSlope: 0.06, signChangedInLast2Bars: false, availableBars: 25 })).toBe("UP");

    // 4. DOWN if slope <= -0.05
    expect(determineTrendState({ normalizedSlope: -0.07, signChangedInLast2Bars: false, availableBars: 25 })).toBe("DOWN");

    // 5. SIDEWAYS if abs(slope) < 0.05
    expect(determineTrendState({ normalizedSlope: 0.02, signChangedInLast2Bars: false, availableBars: 25 })).toBe("SIDEWAYS");
  });

  it("evaluates session segments in Asia/Kolkata correctly", () => {
    // 09:05 IST = 03:35 UTC -> PRE_OPEN
    expect(sessionSegmentOf(new Date("2026-08-25T03:35:00.000Z"), "INDEX")).toBe("PRE_OPEN");

    // 09:30 IST = 04:00 UTC -> OPENING
    expect(sessionSegmentOf(new Date("2026-08-25T04:00:00.000Z"), "INDEX")).toBe("OPENING");

    // 11:30 IST = 06:00 UTC -> MIDDAY
    expect(sessionSegmentOf(new Date("2026-08-25T06:00:00.000Z"), "INDEX")).toBe("MIDDAY");

    // 14:30 IST = 09:00 UTC -> CLOSING
    expect(sessionSegmentOf(new Date("2026-08-25T09:00:00.000Z"), "INDEX")).toBe("CLOSING");
  });

  it("refuses a segment outside the session, and closes INDEX at 15:30 but FUTIDX at 15:40", () => {
    // 22:00 IST -- previously labelled CLOSING, which made a bad backfill bar look like a real
    // closing-hour observation.
    expect(sessionSegmentOf(new Date("2026-08-25T16:30:00.000Z"), "INDEX")).toBeNull();
    // 08:00 IST, before the pre-open window opens.
    expect(sessionSegmentOf(new Date("2026-08-25T02:30:00.000Z"), "INDEX")).toBeNull();

    // 15:35 IST = 10:05 UTC. Past the cash close, still inside the derivatives session.
    const afterCashClose = new Date("2026-08-25T10:05:00.000Z");
    expect(sessionSegmentOf(afterCashClose, "INDEX")).toBeNull();
    expect(sessionSegmentOf(afterCashClose, "FUTIDX")).toBe("CLOSING");
  });

  it("calculates pattern geometry correctly", () => {
    const geo = calculatePatternGeometry({
      durationBars: 3,
      patternHigh: 25100,
      patternLow: 24900,
      atrAtDetected: 50,
    });
    expect(geo.durationBars).toBe(3);
    expect(geo.rangeBps).toBeCloseTo(80, 2); // (200 / 25000) * 10000 = 80 bps
    expect(geo.rangeAtr).toBe(4); // 200 / 50 = 4 ATR
  });

  it("refuses geometry rather than emitting a rangeAtr of 0 or 1 during ATR warmup", () => {
    // The old calculator returned rangeAtr: 0 here -- a measurement reading "this pattern's range is
    // zero ATRs wide" when the truth is that ATR is not computable yet.
    expect(() => calculatePatternGeometry({
      durationBars: 3, patternHigh: 25100, patternLow: 24900, atrAtDetected: 0,
    })).toThrow(PatternWarmupError);

    // And the orchestrator's own fallback -- substituting the pattern range for the missing ATR --
    // yielded exactly 1.0, which is worse: indistinguishable from an ordinary one-ATR-wide pattern.
    const fabricated = calculatePatternGeometry({
      durationBars: 3, patternHigh: 25100, patternLow: 24900, atrAtDetected: 25100 - 24900,
    });
    expect(fabricated.rangeAtr).toBe(1);
  });

  it("pins the warmup floor to the ATR period, where the first non-null ATR appears", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      openTime: new Date(Date.UTC(2026, 7, 25, 4, i)),
      open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 1000,
    }));
    const atrs = calculateAtrSeries(candles, atrPeriod);
    expect(minimumClosedBarsForEmission).toBe(atrPeriod);
    // Index 12 is the 13th closed bar -- one short of the floor, and null.
    expect(atrs[minimumClosedBarsForEmission - 2]).toBeNull();
    // Index 13 is the 14th closed bar -- exactly the floor, and the first real value.
    expect(atrs[minimumClosedBarsForEmission - 1]).not.toBeNull();
  });

  it("returns null for a volume z-score whose window contains a zero-volume bar", () => {
    // A window straddling the 2025/2026 index volume break: real volumes, then literal zeros.
    // This is the case that slipped through -- it has a large, entirely meaningless stddev, so the
    // existing `stddev === 0` guard does not fire and a huge z-score is produced.
    const straddling = [...Array.from({ length: 10 }, () => 50_000), ...Array.from({ length: 10 }, () => 0)];
    expect(calculateZScore(straddling, 20)).not.toBeNull(); // the unguarded statistic still computes
    expect(calculateVolumeZScore(straddling, 20)).toBeNull(); // the volume-aware one refuses
    expect(calculateVolumeMultiplier(straddling, 20)).toBeNull();

    // A single zero anywhere in the window is enough to make the window unknown.
    const oneZero = Array.from({ length: 20 }, (_, i) => (i === 7 ? 0 : 50_000 + i));
    expect(calculateVolumeZScore(oneZero, 20)).toBeNull();

    // A fully volume-positive window still computes.
    const clean = Array.from({ length: 20 }, (_, i) => 50_000 + i * 100);
    expect(calculateVolumeZScore(clean, 20)).not.toBeNull();
    expect(calculateVolumeMultiplier(clean, 20)).toBeGreaterThan(1);
  });

  it("propagates the zero-volume rule into PatternContext.volumeZscore for every family", () => {
    // volumeZscore sits in the shared context, so a contaminated window would otherwise reach all
    // 18 families, not only EFFORT_RESULT.
    const candles = Array.from({ length: 20 }, (_, i) => ({
      openTime: new Date(Date.UTC(2026, 7, 25, 4, 30 + i)), // 10:00 IST onwards -> MIDDAY
      open: 25000 + i, high: 25050 + i * 2, low: 24950 - i, close: 25020 + i,
      volume: i < 10 ? 50_000 : 0,
    }));
    const atrs = calculateAtrSeries(candles, atrPeriod);
    const emas = calculateEmaSeries(candles.map((c) => c.close), 20);

    const context = calculatePatternContext(candles, 19, atrs, emas, "INDEX");
    expect(context.volumeZscore).toBeNull();
    // The divergence depends on volume, so it must fall away with it.
    expect(context.effortResultDivergence).toBeNull();
    // The range z-score is unaffected -- it does not depend on volume.
    expect(context.rangeZscore).not.toBeNull();
    expect(context.sessionSegment).toBe("MIDDAY");
  });

  it("keeps effortResultDivergence exactly equal to the stored z-score difference", () => {
    // Regression. The divergence used to be round(rawVol - rawRange) while the z-scores were stored
    // as round(rawVol) and round(rawRange), so the exact equality validateObservation enforces broke
    // on ~70% of bars with realistic prices -- and because that validator throws, one bad bar aborted
    // the whole detection run. Every prior fixture was either under 20 bars (both z-scores null) or
    // perfectly flat (difference landed on a round number), so nothing caught it until this was run
    // against real BANKNIFTY 1m data.
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const candles = Array.from({ length: 40 }, (_, i) => {
      const base = 24500 + rnd() * 80;
      return {
        openTime: new Date(Date.UTC(2026, 7, 25, 5, i)), // 10:30 IST onwards
        open: base, high: base + rnd() * 30, low: base - rnd() * 30,
        close: base + rnd() * 10, volume: Math.floor(40_000 + rnd() * 90_000),
      };
    });
    const atrs = calculateAtrSeries(candles, atrPeriod);
    const emas = calculateEmaSeries(candles.map((c) => c.close), 20);

    let checked = 0;
    for (let i = 19; i < candles.length; i++) {
      const ctx = calculatePatternContext(candles, i, atrs, emas, "INDEX");
      if (ctx.volumeZscore === null || ctx.rangeZscore === null) {
        expect(ctx.effortResultDivergence).toBeNull();
        continue;
      }
      // Exact equality, not toBeCloseTo -- the validator compares with ===.
      expect(ctx.effortResultDivergence).toBe(ctx.volumeZscore - ctx.rangeZscore);
      checked++;
    }
    expect(checked).toBeGreaterThan(15); // the series must actually exercise the path
  });

  it("refuses a context for a bar outside the session instead of stamping MIDDAY", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      openTime: new Date(Date.UTC(2026, 7, 25, 16, i)), // 21:30 IST -- not a session bar
      open: 25000, high: 25050, low: 24950, close: 25020, volume: 1000,
    }));
    const atrs = calculateAtrSeries(candles, atrPeriod);
    const emas = calculateEmaSeries(candles.map((c) => c.close), 20);
    expect(() => calculatePatternContext(candles, 19, atrs, emas, "INDEX")).toThrow(PatternWarmupError);

    // And an out-of-range index is a caller defect, not a MIDDAY context with null statistics.
    expect(() => calculatePatternContext(candles, 99, atrs, emas, "INDEX")).toThrow(PatternWarmupError);
  });
});
