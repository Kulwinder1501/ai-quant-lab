import { atrSeries } from "./atr-series.js";
import { isIntradayTimeframe, timeframeMinutes } from "./session-segmentation.js";
import type { DetectedPriceActionEvent, PatternCandle, PatternDirection, PriceActionEventCode } from "./market-pattern.js";

/**
 * How a distance threshold is measured.
 *
 * `PERCENT` measures one unit as 1% of the reference price. That is fine on daily
 * bars and meaningless on minute bars, where a 1% move over twenty candles is a
 * violent session rather than a trend.
 *
 * `ATR` measures one unit as one ATR, so the same configuration means the same thing
 * on every timeframe and instrument. This is the mode to use for intraday work.
 */
export type PriceActionThresholdMode = "PERCENT" | "ATR";

export interface PriceActionConfiguration {
  swingWindow: number;
  levelLookback: number;
  breakoutLookback: number;
  trendLookback: number;
  pullbackLookback: number;
  /** How one distance unit is defined. See {@link PriceActionThresholdMode}. */
  thresholdMode: PriceActionThresholdMode;
  /** Only read in `ATR` mode. Matches the `ta-v1` ATR definition. */
  atrPeriod: number;
  // Every threshold below is a count of units, not a percentage. The defaults are the
  // percentage rules the engine has always used, restated in units: the old 0.1%
  // breakout buffer is 0.1 units, the old 1% trend threshold is 1 unit, and so on.
  // Because one unit is 1% of price in PERCENT mode, the two modes agree closely on
  // daily NIFTY, where ATR(14) runs near 1% of price. That is what makes switching
  // modes on the same history an honest comparison rather than a different rule set.
  breakoutBufferUnits: number;
  trendThresholdUnits: number;
  pullbackUnits: number;
  levelToleranceUnits: number;
  /**
   * How many separate visits to a swing's price band (the pivot itself is the first) a swing needs before it is also reported as
   * SUPPORT or RESISTANCE. The raw SWING_HIGH / SWING_LOW event is always emitted. Absent means 1, which is every swing: the
   * behaviour before `price-action-v4`. The current version asks for 2 below 15m, so an isolated five-candle swing is not called a level.
   */
  levelMinTouches?: number;
}

const defaultConfiguration: PriceActionConfiguration = {
  swingWindow: 2,
  levelLookback: 50,
  breakoutLookback: 20,
  trendLookback: 20,
  pullbackLookback: 10,
  thresholdMode: "PERCENT",
  atrPeriod: 14,
  breakoutBufferUnits: 0.1,
  trendThresholdUnits: 1,
  pullbackUnits: 2,
  levelToleranceUnits: 0.3,
};

/** Recommended starting point for intraday timeframes. */
export const atrPriceActionConfiguration: PriceActionConfiguration = {
  ...defaultConfiguration,
  thresholdMode: "ATR",
};

/**
 * The configuration the current price-action version (`price-action-v4`) uses for a timeframe: ATR units on intraday, percent on daily,
 * plus a retest before a swing is also called SUPPORT or RESISTANCE (`levelMinTouches`) on the timeframes where a five-candle swing is
 * only minutes of price. The other three corrections live in the application layer, which is where the sessions are cut.
 *
 * The unit is by timeframe because the percent unit made the trend rule "1% over 20 bars", which on 1m is a violent session rather than
 * a trend, so intraday trend/breakout/pullback rules were effectively silent. The same unit-count thresholds are measured in the
 * volatility of the bar size being read. Every event records `thresholdMode` in its details, so a stored row states which unit produced it.
 *
 * The retest is asked for below 15m only. On 1m and 5m a swing spans 5 to 25 minutes, so most are noise and a revisit is the cheapest
 * evidence of a level. From 15m up a swing spans 75 minutes to 5 hours and there are few of them, so requiring a revisit hides most real
 * levels (replayed on both indices over six sessions: 30m kept 5 support/resistance rows out of 15 swings, and daily lost about a fifth
 * of its rows for nothing). The threshold is a judgment, not tuned on outcomes.
 */
export function priceActionConfigurationForTimeframe(timeframe: string): PriceActionConfiguration {
  const base = isIntradayTimeframe(timeframe) ? atrPriceActionConfiguration : defaultConfiguration;
  const minutes = timeframeMinutes(timeframe);
  return { ...base, levelMinTouches: minutes !== null && minutes < 15 ? 2 : 1 };
}

/**
 * Whether the price-action rules run over the whole series instead of one session at a time: the intraday timeframes
 * from 15m up.
 *
 * The trend, breakout and pullback rules look back 20 and 10 candles. A session holds 75 candles on 5m but only 25 on 15m, 13 on 30m and 7
 * on 60m, so cut into sessions the rules cannot fire there before 14:15 on 15m and never on 30m or 60m, and a 20-candle window is 5 hours
 * to about 3 days at those sizes, which is multi-session by nature (the daily timeframe is already one series). Candlestick and chart
 * patterns stay per session: they were cut at the session so a 09:15 bar could not be read against yesterday's bars.
 */
export function priceActionSpansSessions(timeframe: string): boolean {
  const minutes = timeframeMinutes(timeframe);
  return minutes !== null && minutes >= 15 && isIntradayTimeframe(timeframe);
}

type Trend = "UPTREND" | "DOWNTREND" | "RANGE";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function event(
  candle: PatternCandle,
  eventCode: PriceActionEventCode,
  direction: PatternDirection,
  level: number | null,
  confidence: number,
  details: Record<string, unknown>,
): DetectedPriceActionEvent {
  return { candleId: candle.id, eventCode, direction, level, confidence: clamp(confidence), details };
}


/**
 * The size of one distance unit, or null when it cannot be measured yet. In `ATR`
 * mode that means the ATR is still inside its warm-up window, so no distance rule can
 * fire; returning null keeps the engine silent instead of guessing a scale.
 */
function distanceUnit(
  configuration: PriceActionConfiguration,
  atrValues: readonly (number | null)[],
  index: number,
  referencePrice: number,
): number | null {
  if (configuration.thresholdMode === "ATR") {
    const atr = atrValues[index];
    return atr !== null && atr !== undefined && atr > 0 ? atr : null;
  }
  return referencePrice > 0 ? referencePrice * 0.01 : null;
}

interface TrendReading {
  trend: Trend;
  change: number;
  changePercent: number;
  magnitudeUnits: number;
}

function trendAt(
  candles: readonly PatternCandle[],
  index: number,
  configuration: PriceActionConfiguration,
  atrValues: readonly (number | null)[],
): TrendReading | null {
  if (index < configuration.trendLookback) return null;
  const startClose = candles[index - configuration.trendLookback].close;
  const unit = distanceUnit(configuration, atrValues, index, startClose);
  if (unit === null) return null;

  const change = candles[index].close - startClose;
  const threshold = unit * configuration.trendThresholdUnits;
  const magnitudeUnits = Math.abs(change) / unit;
  const reading = { change, changePercent: change / startClose, magnitudeUnits };
  if (change >= threshold) return { trend: "UPTREND", ...reading };
  if (change <= -threshold) return { trend: "DOWNTREND", ...reading };
  return { trend: "RANGE", ...reading };
}

/**
 * A trend scores on how far price travelled, but a range scores on how little it
 * travelled. Sharing one magnitude-increasing formula would rank a near-threshold
 * drift as a stronger range than a flat market.
 */
function trendConfidence(reading: TrendReading, configuration: PriceActionConfiguration): number {
  if (reading.trend !== "RANGE") return 0.55 + Math.min(0.35, reading.magnitudeUnits * 0.05);
  const flatness = configuration.trendThresholdUnits > 0
    ? 1 - Math.min(1, reading.magnitudeUnits / configuration.trendThresholdUnits)
    : 0;
  return 0.55 + 0.35 * flatness;
}

/** Confidence for a crossing, scaled by how far past its trigger the close landed. */
function crossingConfidence(base: number, excess: number, unit: number): number {
  return base + Math.min(0.25, (excess / unit) * 0.2);
}

interface BreakoutLevels {
  resistance: number;
  support: number;
  upperTrigger: number;
  lowerTrigger: number;
}

function breakoutLevelsAt(
  candles: readonly PatternCandle[],
  index: number,
  configuration: PriceActionConfiguration,
  atrValues: readonly (number | null)[],
): BreakoutLevels | null {
  if (index < 1 || index < configuration.breakoutLookback) return null;
  const prior = candles.slice(index - configuration.breakoutLookback, index);
  const resistance = Math.max(...prior.map((candle) => candle.high));
  const support = Math.min(...prior.map((candle) => candle.low));
  const upperUnit = distanceUnit(configuration, atrValues, index, resistance);
  const lowerUnit = distanceUnit(configuration, atrValues, index, support);
  if (upperUnit === null || lowerUnit === null) return null;
  return {
    resistance,
    support,
    upperTrigger: resistance + upperUnit * configuration.breakoutBufferUnits,
    lowerTrigger: support - lowerUnit * configuration.breakoutBufferUnits,
  };
}

function isSwingHigh(candles: readonly PatternCandle[], pivotIndex: number, window: number): boolean {
  if (pivotIndex < window || pivotIndex + window >= candles.length) return false;
  const pivot = candles[pivotIndex].high;
  let hasStrictlyLowerNeighbor = false;
  for (let index = pivotIndex - window; index <= pivotIndex + window; index += 1) {
    if (index === pivotIndex) continue;
    if (candles[index].high > pivot) return false;
    if (candles[index].high < pivot) hasStrictlyLowerNeighbor = true;
  }
  return hasStrictlyLowerNeighbor;
}

function isSwingLow(candles: readonly PatternCandle[], pivotIndex: number, window: number): boolean {
  if (pivotIndex < window || pivotIndex + window >= candles.length) return false;
  const pivot = candles[pivotIndex].low;
  let hasStrictlyHigherNeighbor = false;
  for (let index = pivotIndex - window; index <= pivotIndex + window; index += 1) {
    if (index === pivotIndex) continue;
    if (candles[index].low < pivot) return false;
    if (candles[index].low > pivot) hasStrictlyHigherNeighbor = true;
  }
  return hasStrictlyHigherNeighbor;
}

/**
 * Counts distinct visits to a level rather than candles near it. Consecutive candles
 * inside the tolerance band are one touch, so a single consolidation against a level
 * cannot inflate the count the way a raw candle tally does.
 */
function levelTouches(candles: readonly PatternCandle[], level: number, kind: "HIGH" | "LOW", tolerance: number): number {
  let touches = 0;
  let insideBand = false;
  for (const candle of candles) {
    const price = kind === "HIGH" ? candle.high : candle.low;
    const isInsideBand = Math.abs(price - level) <= tolerance;
    if (isInsideBand && !insideBand) touches += 1;
    insideBand = isInsideBand;
  }
  return touches;
}

/**
 * Transparent, non-predictive price-action rules. Swing points are emitted only
 * after their required future confirmation candles have closed.
 *
 * Every distance threshold is expressed in units rather than as a raw percentage, so
 * one configuration carries across timeframes. Switching `thresholdMode` changes what
 * the rules mean and therefore requires a new algorithm version for anything it
 * persists; each emitted event records its mode in `details` so stored evidence says
 * which definition produced it.
 */
export class PriceActionEngine {
  constructor(private readonly configuration: PriceActionConfiguration = defaultConfiguration) {}

  /** True when distances are measured in ATR units, so a caller may supply an ATR computed over a longer history than the candles it passes. */
  get usesAtr(): boolean {
    return this.configuration.thresholdMode === "ATR";
  }

  get atrPeriod(): number {
    return this.configuration.atrPeriod;
  }

  /**
   * `options.atrValues`, in ATR mode only, replaces the ATR the engine would compute from `candles` alone; it must be index-aligned
   * with `candles`. The application uses it to carry the ATR across sessions: handed one session at a time, the engine's own ATR
   * restarts every morning and stays empty for the first `atrPeriod - 1` candles, so the opening range produced no swing, level or
   * breakout at all (measured on NIFTY 5m, 2026-10-29: nothing before 10:25).
   */
  detect(candles: readonly PatternCandle[], options: { atrValues?: readonly (number | null)[] } = {}): DetectedPriceActionEvent[] {
    const results: DetectedPriceActionEvent[] = [];
    if (options.atrValues !== undefined && options.atrValues.length !== candles.length) {
      throw new Error("atrValues must be index-aligned with the candles.");
    }
    const atrValues = this.configuration.thresholdMode === "ATR"
      ? (options.atrValues ?? atrSeries(candles, this.configuration.atrPeriod))
      : [];
    const thresholdMode = this.configuration.thresholdMode;
    const minTouches = this.configuration.levelMinTouches ?? 1;
    let previousTrend: Trend | null = null;

    for (let index = 0; index < candles.length; index += 1) {
      const current = candles[index];
      const trend = trendAt(candles, index, this.configuration, atrValues);
      if (trend && trend.trend !== previousTrend) {
        const direction: PatternDirection = trend.trend === "UPTREND" ? "BULLISH" : trend.trend === "DOWNTREND" ? "BEARISH" : "NEUTRAL";
        results.push(event(current, trend.trend, direction, null, trendConfidence(trend, this.configuration), {
          lookback: this.configuration.trendLookback,
          changePercent: trend.changePercent,
          change: trend.change,
          thresholdMode,
        }));
        previousTrend = trend.trend;
      }

      const levels = breakoutLevelsAt(candles, index, this.configuration, atrValues);
      if (levels) {
        // The barrier must be measured as of the previous candle too. Its own high is
        // inside the current window, so comparing the previous close with the current
        // trigger can never detect a crossing and would re-report one advance as a
        // fresh breakout on every candle.
        const previousLevels = breakoutLevelsAt(candles, index - 1, this.configuration, atrValues);
        const previousClose = candles[index - 1].close;
        const wasAlreadyAbove = previousLevels !== null && previousClose > previousLevels.upperTrigger;
        const wasAlreadyBelow = previousLevels !== null && previousClose < previousLevels.lowerTrigger;
        const upperUnit = distanceUnit(this.configuration, atrValues, index, levels.resistance);
        const lowerUnit = distanceUnit(this.configuration, atrValues, index, levels.support);
        if (upperUnit !== null && current.close > levels.upperTrigger && !wasAlreadyAbove) {
          results.push(event(current, "BREAKOUT", "BULLISH", levels.resistance, crossingConfidence(0.65, current.close - levels.upperTrigger, upperUnit), {
            lookback: this.configuration.breakoutLookback,
            trigger: levels.upperTrigger,
            close: current.close,
            thresholdMode,
          }));
        }
        if (lowerUnit !== null && current.close < levels.lowerTrigger && !wasAlreadyBelow) {
          results.push(event(current, "BREAKDOWN", "BEARISH", levels.support, crossingConfidence(0.65, levels.lowerTrigger - current.close, lowerUnit), {
            lookback: this.configuration.breakoutLookback,
            trigger: levels.lowerTrigger,
            close: current.close,
            thresholdMode,
          }));
        }
      }

      if (trend && index >= this.configuration.pullbackLookback) {
        const prior = candles.slice(index - this.configuration.pullbackLookback, index);
        const previousClose = candles[index - 1].close;
        if (trend.trend === "UPTREND") {
          const recentHigh = Math.max(...prior.map((candle) => candle.high));
          const unit = distanceUnit(this.configuration, atrValues, index, recentHigh);
          const trigger = unit === null ? null : recentHigh - unit * this.configuration.pullbackUnits;
          if (unit !== null && trigger !== null && current.close < trigger && previousClose >= trigger) {
            results.push(event(current, "PULLBACK", "BULLISH", recentHigh, crossingConfidence(0.55, trigger - current.close, unit), {
              trend: trend.trend,
              recentHigh,
              trigger,
              thresholdMode,
            }));
          }
        }
        if (trend.trend === "DOWNTREND") {
          const recentLow = Math.min(...prior.map((candle) => candle.low));
          const unit = distanceUnit(this.configuration, atrValues, index, recentLow);
          const trigger = unit === null ? null : recentLow + unit * this.configuration.pullbackUnits;
          if (unit !== null && trigger !== null && current.close > trigger && previousClose <= trigger) {
            results.push(event(current, "PULLBACK", "BEARISH", recentLow, crossingConfidence(0.55, current.close - trigger, unit), {
              trend: trend.trend,
              recentLow,
              trigger,
              thresholdMode,
            }));
          }
        }
      }

      const pivotIndex = index - this.configuration.swingWindow;
      if (isSwingHigh(candles, pivotIndex, this.configuration.swingWindow)) {
        const pivot = candles[pivotIndex];
        const unit = distanceUnit(this.configuration, atrValues, index, pivot.high);
        if (unit !== null) {
          const context = candles.slice(Math.max(0, pivotIndex - this.configuration.levelLookback), index + 1);
          const touches = levelTouches(context, pivot.high, "HIGH", unit * this.configuration.levelToleranceUnits);
          const detail = { pivotCandleId: pivot.id, confirmationCandleId: current.id, touches, swingWindow: this.configuration.swingWindow, thresholdMode };
          const score = 0.5 + Math.min(0.4, touches * 0.08);
          results.push(event(current, "SWING_HIGH", "BEARISH", pivot.high, score, detail));
          if (touches >= minTouches) results.push(event(current, "RESISTANCE", "BEARISH", pivot.high, score, detail));
        }
      }
      if (isSwingLow(candles, pivotIndex, this.configuration.swingWindow)) {
        const pivot = candles[pivotIndex];
        const unit = distanceUnit(this.configuration, atrValues, index, pivot.low);
        if (unit !== null) {
          const context = candles.slice(Math.max(0, pivotIndex - this.configuration.levelLookback), index + 1);
          const touches = levelTouches(context, pivot.low, "LOW", unit * this.configuration.levelToleranceUnits);
          const detail = { pivotCandleId: pivot.id, confirmationCandleId: current.id, touches, swingWindow: this.configuration.swingWindow, thresholdMode };
          const score = 0.5 + Math.min(0.4, touches * 0.08);
          results.push(event(current, "SWING_LOW", "BULLISH", pivot.low, score, detail));
          if (touches >= minTouches) results.push(event(current, "SUPPORT", "BULLISH", pivot.low, score, detail));
        }
      }
    }
    return results;
  }
}
