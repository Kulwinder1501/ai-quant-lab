import type { PatternCandle } from "./market-pattern.js";

/**
 * Wilder ATR over the same true-range convention as the `ta-v1` indicator, computed
 * inside the engine so the rules stay a pure function of the candle series. Values
 * are unrounded, so they differ from a persisted `ta-v1` snapshot only by that
 * indicator's display rounding.
 */
export function atrSeries(candles: readonly PatternCandle[], period: number): (number | null)[] {
  const result: (number | null)[] = Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return result;

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });

  let average = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < trueRanges.length; index += 1) {
    average = ((average * (period - 1)) + trueRanges[index]) / period;
    result[index] = average;
  }
  return result;
}
