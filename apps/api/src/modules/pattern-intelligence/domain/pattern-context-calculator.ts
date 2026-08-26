import type {
  ObservationSource,
  PatternContext,
  PatternGeometry,
  PatternTrendState,
} from "./contracts.js";
import { sessionSegmentOf } from "./session-windows.js";
import { isVolumeWindowUsable } from "./volume-semantics.js";

export interface CandleLike {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Wilder ATR period, and the number of closed bars a detector requires before it may emit.
 *
 * These are the same number for a reason. `calculateAtrSeries` produces its first non-null value at
 * index `period - 1`, i.e. once 14 bars are closed, so "ATR is available" and "14 closed bars exist"
 * coincide exactly. Errata Section 3 states the rule in the second form; this constant is the first.
 */
export const atrPeriod = 14;

/**
 * The strict non-emission floor (errata Section 3).
 *
 * A bar with fewer closed bars behind it than this cannot produce a finite `rangeAtr`, and the module
 * refuses to emit rather than substituting anything for the missing denominator.
 */
export const minimumClosedBarsForEmission = atrPeriod;

/** The rolling window for `volumeZscore`, `rangeZscore` and the effort/result statistics. */
export const contextWindowBars = 20;

export class PatternWarmupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternWarmupError";
  }
}

/**
 * Calculates Wilder's smoothed ATR (period 14 by default).
 * Returns array of same length as candles, with null for initial warm-up bars.
 */
export function calculateAtrSeries(candles: readonly CandleLike[], period = 14): (number | null)[] {
  if (candles.length === 0) return [];
  const results: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return results;

  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i]!;
    if (i === 0) {
      trueRanges.push(current.high - current.low);
      continue;
    }
    const prev = candles[i - 1]!;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    );
    trueRanges.push(tr);
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[i]!;
  }
  let currentAtr = sum / period;
  results[period - 1] = currentAtr;

  for (let i = period; i < candles.length; i++) {
    currentAtr = (currentAtr * (period - 1) + trueRanges[i]!) / period;
    results[i] = currentAtr;
  }

  return results;
}

/**
 * Calculates EMA series for a given period.
 */
export function calculateEmaSeries(values: readonly number[], period: number): (number | null)[] {
  if (values.length === 0) return [];
  const results: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return results;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i]!;
  }
  let currentEma = sum / period;
  results[period - 1] = currentEma;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    currentEma = (values[i]! - currentEma) * multiplier + currentEma;
    results[i] = currentEma;
  }

  return results;
}

/**
 * Calculates rolling z-score over a window (e.g. 20 bars).
 * Population standard deviation is used. Returns null if < windowSize or if stddev is 0.
 */
export function calculateZScore(values: readonly number[], windowSize = 20): number | null {
  if (values.length < windowSize) return null;
  const slice = values.slice(-windowSize);
  const mean = slice.reduce((acc, v) => acc + v, 0) / windowSize;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / windowSize;
  const stddev = Math.sqrt(variance);
  if (stddev === 0 || !Number.isFinite(stddev)) return null;
  const latest = slice[slice.length - 1]!;
  return (latest - mean) / stddev;
}

/**
 * A z-score over volume, which is `calculateZScore` plus a validity precondition on the window.
 *
 * A stored volume of `0` means "unknown", not "no activity", so a window containing one has no
 * computable statistic. Critically, such a window is *not* caught by the `stddev === 0` guard above:
 * a window straddling the 2025/2026 index volume break mixes real volumes with literal zeros, giving
 * a large stddev and an enormous z-score that clears every effort/result threshold. See
 * `volume-semantics.ts` for the measured coverage and the reasoning.
 */
export function calculateVolumeZScore(volumes: readonly number[], windowSize = contextWindowBars): number | null {
  if (volumes.length < windowSize) return null;
  const slice = volumes.slice(-windowSize);
  if (!isVolumeWindowUsable(slice)) return null;
  return calculateZScore(slice, windowSize);
}

/**
 * Bar volume over its trailing simple mean, or null when the window is not fully volume-positive.
 *
 * The window includes the bar itself, matching the z-score window so the two statistics are computed
 * over the same population and become null together.
 */
export function calculateVolumeMultiplier(volumes: readonly number[], windowSize = contextWindowBars): number | null {
  if (volumes.length < windowSize) return null;
  const slice = volumes.slice(-windowSize);
  if (!isVolumeWindowUsable(slice)) return null;
  const mean = slice.reduce((acc, v) => acc + v, 0) / windowSize;
  if (!(mean > 0)) return null;
  const latest = slice[slice.length - 1]!;
  return Number((latest / mean).toFixed(6));
}

/**
 * Normalized slope = (EMA20[bar0] - EMA20[bar2]) / (2 * ATR14)
 * Expressed in ATR units per bar.
 */
export function calculateNormalizedSlope(
  ema20_0: number,
  ema20_2: number,
  atr14: number,
): number | null {
  if (atr14 <= 0 || !Number.isFinite(atr14)) return null;
  return (ema20_0 - ema20_2) / (2 * atr14);
}

/**
 * Precedence-ordered Trend State evaluation per specification:
 * 1. UNKNOWN       if fewer than 20 bars available or normalizedSlope is null
 * 2. TRANSITIONING if EMA20 slope sign changed within last 2 bars AND abs(normalizedSlope) >= 0.05
 * 3. UP            if normalizedSlope >= 0.05 (no sign change in last 2 bars)
 * 4. DOWN          if normalizedSlope <= -0.05 (no sign change in last 2 bars)
 * 5. SIDEWAYS      if abs(normalizedSlope) < 0.05
 */
export function determineTrendState(input: {
  normalizedSlope: number | null;
  signChangedInLast2Bars: boolean;
  availableBars: number;
}): PatternTrendState {
  if (input.availableBars < 20 || input.normalizedSlope === null || !Number.isFinite(input.normalizedSlope)) {
    return "UNKNOWN";
  }

  const absSlope = Math.abs(input.normalizedSlope);
  if (input.signChangedInLast2Bars && absSlope >= 0.05) {
    return "TRANSITIONING";
  }
  if (input.normalizedSlope >= 0.05) {
    return "UP";
  }
  if (input.normalizedSlope <= -0.05) {
    return "DOWN";
  }
  return "SIDEWAYS";
}

/**
 * Computes full PatternGeometry for a pattern formation.
 *
 * Refuses rather than substituting. Both denominators here — the range midpoint and ATR — are
 * required to be usable, and there is deliberately no fallback for either. The previous `: 0` on
 * `rangeAtr` claimed a pattern was zero ATRs wide whenever ATR was unavailable, which is a
 * measurement, not a gap, and it was covered by `observationHash`.
 *
 * By errata Section 3 a caller must not reach this function before warmup completes; the throw is
 * defence in depth, so a future caller that forgets the gate fails loudly instead of emitting a
 * fabricated geometry.
 */
export function calculatePatternGeometry(input: {
  durationBars: number;
  patternHigh: number;
  patternLow: number;
  atrAtDetected: number;
}): PatternGeometry {
  if (!Number.isFinite(input.atrAtDetected) || input.atrAtDetected <= 0) {
    throw new PatternWarmupError(
      `Pattern geometry needs a usable ATR(${atrPeriod}); got ${input.atrAtDetected}. A detector must `
      + `refuse to emit before ${minimumClosedBarsForEmission} closed bars are available.`,
    );
  }
  const midpoint = (input.patternHigh + input.patternLow) / 2;
  if (!Number.isFinite(midpoint) || midpoint <= 0) {
    throw new PatternWarmupError(`Pattern geometry needs a positive range midpoint; got ${midpoint}.`);
  }
  const rangeBps = ((input.patternHigh - input.patternLow) / midpoint) * 10000;
  const rangeAtr = (input.patternHigh - input.patternLow) / input.atrAtDetected;
  return {
    durationBars: input.durationBars,
    rangeBps: Number(rangeBps.toFixed(6)),
    rangeAtr: Number(rangeAtr.toFixed(6)),
  };
}

/**
 * Computes PatternContext for closed candles up to a given index.
 */
export function calculatePatternContext(
  candles: readonly CandleLike[],
  currentIndex: number,
  atrSeries: readonly (number | null)[],
  ema20Series: readonly (number | null)[],
  instrumentType: ObservationSource["instrumentType"],
): PatternContext {
  const currentCandle = candles[currentIndex];
  if (!currentCandle) {
    // Previously this returned a context stamped MIDDAY with null statistics -- a fabricated segment
    // for a bar that does not exist. An out-of-range index is a caller defect, so it fails here.
    throw new PatternWarmupError(`No candle at index ${currentIndex}; cannot compute a pattern context.`);
  }

  const sessionSegment = sessionSegmentOf(currentCandle.openTime, instrumentType);
  if (sessionSegment === null) {
    throw new PatternWarmupError(
      `Candle at index ${currentIndex} (${currentCandle.openTime.toISOString()}) falls outside the `
      + "observable session. A detector must refuse to emit rather than assign it a segment.",
    );
  }
  const availableBars = currentIndex + 1;

  // 1. Z-scores over the rolling context window.
  const volumeValues: number[] = [];
  const rangeValues: number[] = [];
  const startIdx = Math.max(0, currentIndex - (contextWindowBars - 1));
  for (let i = startIdx; i <= currentIndex; i++) {
    const c = candles[i]!;
    volumeValues.push(c.volume);
    rangeValues.push(c.high - c.low);
  }
  // Volume uses the validity-checked variant: a zero in the window means unknown, not zero activity.
  const rawVolumeZscore = calculateVolumeZScore(volumeValues, contextWindowBars);
  const rawRangeZscore = calculateZScore(rangeValues, contextWindowBars);

  /*
   * Round first, then subtract — never the reverse.
   *
   * `validateObservation` enforces `effortResultDivergence === volumeZscore - rangeZscore` as an
   * exact equality on the *stored* values. Computing the difference from the unrounded z-scores and
   * rounding the result breaks that in two separate ways: `round(a - b)` differs from
   * `round(a) - round(b)` whenever the 7th decimal carries (a ~1e-6 gap), and even when it does not,
   * the float difference of two rounded doubles need not be the double nearest their decimal
   * difference (a ~1e-16 gap). Measured on a realistic 40-bar series, 15 of 21 eligible bars broke
   * the invariant — and because the validator throws, a single such bar aborted the whole detection
   * run rather than degrading one observation.
   *
   * It survived every existing fixture only because they were all either shorter than the 20-bar
   * window, so both z-scores were null, or perfectly flat, so the difference landed on a round
   * number. Real BANKNIFTY 1m data hit it immediately.
   *
   * Deriving the divergence from the stored values makes the invariant true by construction: the
   * validator recomputes the identical expression on the identical doubles. It is deliberately not
   * re-rounded, because rounding it again is exactly what reintroduces the discrepancy.
   */
  const volumeZscore = rawVolumeZscore !== null ? Number(rawVolumeZscore.toFixed(6)) : null;
  const rangeZscore = rawRangeZscore !== null ? Number(rawRangeZscore.toFixed(6)) : null;
  const effortResultDivergence =
    volumeZscore !== null && rangeZscore !== null ? volumeZscore - rangeZscore : null;

  // 2. Trend state from EMA20 and ATR14
  let normalizedSlope: number | null = null;
  let signChangedInLast2Bars = false;

  const currentEma = ema20Series[currentIndex] ?? null;
  const ema2BarsAgo = currentIndex >= 2 ? (ema20Series[currentIndex - 2] ?? null) : null;
  const ema1BarAgo = currentIndex >= 1 ? (ema20Series[currentIndex - 1] ?? null) : null;
  const currentAtr = atrSeries[currentIndex] ?? null;

  if (currentEma !== null && ema2BarsAgo !== null && currentAtr !== null && currentAtr > 0) {
    normalizedSlope = calculateNormalizedSlope(currentEma, ema2BarsAgo, currentAtr);

    if (ema1BarAgo !== null) {
      const slope1 = currentEma - ema1BarAgo;
      const slope2 = ema1BarAgo - ema2BarsAgo;
      if ((slope1 > 0 && slope2 < 0) || (slope1 < 0 && slope2 > 0)) {
        signChangedInLast2Bars = true;
      }
    }
  }

  const trendState = determineTrendState({
    normalizedSlope,
    signChangedInLast2Bars,
    availableBars,
  });

  // Already rounded above; re-rounding here is what broke the divergence invariant.
  return { trendState, sessionSegment, volumeZscore, rangeZscore, effortResultDivergence };
}
