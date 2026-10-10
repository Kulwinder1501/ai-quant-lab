import { isFlatBar } from "../../market-data/domain/flat-bar.js";
import type { PatternCandle } from "./market-pattern.js";

/**
 * Wilder ATR over the same true-range convention as the `ta-v1` indicator, computed
 * inside the engine so the rules stay a pure function of the candle series. Values
 * are unrounded, so they differ from a persisted `ta-v1` snapshot only by that
 * indicator's display rounding.
 *
 * Frozen-feed bars (`high == low && volume == 0`, see `flat-bar.ts`) are excluded from the
 * average exactly as the stored indicator excludes them: the output stays index-aligned with the
 * input, and a flat bar simply repeats the last live ATR (the average did not move). The first
 * live bar after a frozen stretch takes its true range against the last LIVE close.
 *
 * The first bar of a session uses the prior session's close, so its true range can exceed its
 * own high-low range. That is the Wilder definition and is intentional.
 */
export function atrSeries(candles: readonly PatternCandle[], period: number): (number | null)[] {
  const result: (number | null)[] = Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return result;

  let liveCount = 0;
  let previousLiveClose: number | null = null;
  const seedRanges: number[] = [];
  let average: number | null = null;
  let last: number | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    if (isFlatBar(candle)) {
      result[index] = last;
      continue;
    }
    const trueRange: number = previousLiveClose === null
      ? candle.high - candle.low
      : Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousLiveClose),
        Math.abs(candle.low - previousLiveClose),
      );
    previousLiveClose = candle.close;
    liveCount += 1;
    if (average === null) {
      seedRanges.push(trueRange);
      if (liveCount < period) continue;
      average = seedRanges.reduce((sum, value) => sum + value, 0) / period;
    } else {
      average = ((average * (period - 1)) + trueRange) / period;
    }
    last = average;
    result[index] = average;
  }
  return result;
}
