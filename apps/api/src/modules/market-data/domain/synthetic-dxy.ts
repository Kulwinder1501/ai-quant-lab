/**
 * Reconstructs the real US Dollar Index (DXY) from its 6 real component currency pairs, via the
 * public ICE formula, because Twelve Data does not sell DXY as a single ticker (confirmed
 * 2026-10-06 against their live `/indices` catalog -- 1,308 entries, zero matches for the US
 * Dollar Index under any symbol or name). This is the actual published index formula applied to
 * real quoted rates, not an invented proxy:
 *
 *   DXY = 50.14348112 * EURUSD^-0.576 * USDJPY^0.136 * GBPUSD^-0.119
 *                     * USDCAD^0.091 * USDSEK^0.042 * USDCHF^0.036
 *
 * EUR/USD and GBP/USD are quoted as US dollars per unit of foreign currency (negative exponent:
 * the dollar index rises as these fall), while USD/JPY, USD/CAD, USD/SEK and USD/CHF are quoted
 * as units of foreign currency per dollar (positive exponent). Twelve Data's own quote
 * convention for these 6 pairs already matches that orientation, so no inversion is needed.
 */

const DXY_BASE_CONSTANT = 50.14348112;
const DXY_EXPONENTS = {
  eurUsd: -0.576,
  usdJpy: 0.136,
  gbpUsd: -0.119,
  usdCad: 0.091,
  usdSek: 0.042,
  usdChf: 0.036,
} as const;

export interface DxyComponentRates {
  eurUsd: number;
  usdJpy: number;
  gbpUsd: number;
  usdCad: number;
  usdSek: number;
  usdChf: number;
}

export function computeDxyLevel(rates: DxyComponentRates): number {
  return (
    DXY_BASE_CONSTANT *
    rates.eurUsd ** DXY_EXPONENTS.eurUsd *
    rates.usdJpy ** DXY_EXPONENTS.usdJpy *
    rates.gbpUsd ** DXY_EXPONENTS.gbpUsd *
    rates.usdCad ** DXY_EXPONENTS.usdCad *
    rates.usdSek ** DXY_EXPONENTS.usdSek *
    rates.usdChf ** DXY_EXPONENTS.usdChf
  );
}

export interface OhlcValues {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DxyComponentOhlc {
  eurUsd: OhlcValues;
  usdJpy: OhlcValues;
  gbpUsd: OhlcValues;
  usdCad: OhlcValues;
  usdSek: OhlcValues;
  usdChf: OhlcValues;
}

/**
 * Computes a synthetic DXY bar's open and close exactly (the formula applied to the 6 legs'
 * genuinely-simultaneous open/close quotes), but derives high/low from those same two levels
 * rather than applying the formula separately to each leg's own high/low.
 *
 * The 6 legs' local extrema within a 1-minute bar are not simultaneous, so running the formula
 * on "leg A's high, leg B's high, ..." does not correspond to any real instant the composite
 * actually traded at, and -- because 3 of the 6 exponents are negative -- can even violate the
 * high >= open/close/low invariant `candles_check1`/`candles_check2` enforce. Open and close are
 * real, single-instant composite values; treating them as the bar's high/low bound is the honest
 * choice available from 1-minute OHLC components, not a tick-exact intrabar range.
 */
export function computeSyntheticDxyBar(components: DxyComponentOhlc): OhlcValues {
  const open = computeDxyLevel({
    eurUsd: components.eurUsd.open,
    usdJpy: components.usdJpy.open,
    gbpUsd: components.gbpUsd.open,
    usdCad: components.usdCad.open,
    usdSek: components.usdSek.open,
    usdChf: components.usdChf.open,
  });
  const close = computeDxyLevel({
    eurUsd: components.eurUsd.close,
    usdJpy: components.usdJpy.close,
    gbpUsd: components.gbpUsd.close,
    usdCad: components.usdCad.close,
    usdSek: components.usdSek.close,
    usdChf: components.usdChf.close,
  });
  return {
    open,
    close,
    high: Math.max(open, close),
    low: Math.min(open, close),
  };
}

export interface TimestampedOhlc extends OhlcValues {
  openTime: Date;
  closeTime: Date;
}

/**
 * Standard OHLC resampling: buckets 1-minute bars into fixed windows and rolls each bucket up to
 * open = first bar's open, high = max high, low = min low, close = last bar's close. Used to
 * build the 5m/15m synthetic DXY series from the already-computed 1m synthetic series, which is
 * a real, exact aggregation -- not a second approximation layered on the first.
 *
 * Only emits a bucket once it has exactly `bucketMinutes` 1-minute bars. A short bucket could
 * mean a real, permanent data gap, or it could just be the trailing edge of the rolling
 * collection window this run queried -- the next run will see the rest of its minutes once
 * they're collected. Emitting it now as `isComplete: true` with a partial aggregate, then
 * overwriting it with a different (fuller) value once the rest of its minutes arrive, is exactly
 * what `CandleRepository.upsert`'s completed-candle immutability guard exists to refuse.
 */
export function aggregateOhlcBars(bars: TimestampedOhlc[], bucketMinutes: number): TimestampedOhlc[] {
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map<number, TimestampedOhlc[]>();

  for (const bar of bars) {
    const bucketStart = Math.floor(bar.openTime.getTime() / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);
    if (existing) {
      existing.push(bar);
    } else {
      buckets.set(bucketStart, [bar]);
    }
  }

  const result: TimestampedOhlc[] = [];
  for (const [bucketStart, bucketBars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucketBars.length < bucketMinutes) continue;
    const sorted = [...bucketBars].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
    result.push({
      openTime: new Date(bucketStart),
      closeTime: new Date(bucketStart + bucketMs),
      open: sorted[0].open,
      close: sorted[sorted.length - 1].close,
      high: Math.max(...sorted.map((b) => b.high)),
      low: Math.min(...sorted.map((b) => b.low)),
    });
  }
  return result;
}
