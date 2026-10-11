/**
 * Frozen ("flat") bars: a candle with `high == low` and `volume == 0`.
 *
 * On an exchange holiday the feed can keep emitting bars at the last traded price with no
 * volume and no range. Measured: 2026-09-14 (NSE holiday, no 1d bar) still held 67 of 75
 * NIFTY50 5m bars and 20 of 20 15m bars at 23,398.1. Folded into Wilder ATR those zero true
 * ranges decayed the stored 15m ATR from 37.5 to 8.5 by that day's close (21.8 at the next
 * open), so stops at 1.0x-1.5x ATR were 2-4x too tight. 1,918 zero-volume 5m bars exist overall.
 *
 * A flat bar carries no information about volatility, only about the feed, so every volatility
 * input (ATR, Bollinger, Supertrend, their consumers) excludes them. This is the single
 * definition; do not re-derive it per call site.
 *
 * Note this is deliberately a *conjunction*. Index instruments legitimately report volume 0 on
 * every bar (volume alone is not evidence of a frozen feed), and a real bar can have a one-tick
 * range (high == low is rare but possible on a thin 1m bar that traded at one price WITH volume).
 */

/** A candle-like value with numeric prices. */
export interface FlatBarCandidate {
  readonly high: number;
  readonly low: number;
  /** Absent for sources that do not carry volume; absent is never treated as zero. */
  readonly volume?: number;
}

export function isFlatBar(candle: FlatBarCandidate): boolean {
  return candle.volume !== undefined && candle.volume === 0 && candle.high === candle.low;
}

/** The candles that carry volatility information, in their original order. */
export function withoutFlatBars<T extends FlatBarCandidate>(candles: readonly T[]): T[] {
  return candles.filter((candle) => !isFlatBar(candle));
}

/**
 * Share (0..1) of the trailing `window` bars ending at `endIndex` (inclusive) that are flat.
 * A window shorter than `window` (series start) is measured over the bars that exist.
 */
export function flatShareOfWindow(
  candles: readonly FlatBarCandidate[],
  endIndex: number,
  window: number,
): number {
  const start = Math.max(0, endIndex - window + 1);
  const length = endIndex - start + 1;
  if (length <= 0) return 0;
  let flat = 0;
  for (let index = start; index <= endIndex; index += 1) {
    if (isFlatBar(candles[index]!)) flat += 1;
  }
  return flat / length;
}

/**
 * A volatility window with more than this share of flat bars is not a measurement of the
 * market. Snapshots computed on such a window are not written.
 */
export const MAXIMUM_FLAT_SHARE_OF_WINDOW = 0.5;
