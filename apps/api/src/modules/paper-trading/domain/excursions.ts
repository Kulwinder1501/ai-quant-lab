import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/** Only the extremes matter, so an excursion candle is deliberately narrower than a full candle. */
export interface ExcursionCandle {
  high: number;
  low: number;
}

export interface Excursions {
  /** Furthest the price went against the entry, in price. Never negative. */
  readonly maximumAdverse: number;
  /** Furthest the price went in favour of the entry, in price. Never negative. */
  readonly maximumFavourable: number;
  readonly maximumAdverseR: number;
  readonly maximumFavourableR: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * How far a position ran in favour and against, over the bars it was alive for.
 *
 * Extracted so the closed-trade review and the candidate settlement measure this the same way. They
 * are compared against each other, and two implementations of "how far did it run" drift silently --
 * the arithmetic is simple enough that a second copy looks obviously right while disagreeing at the
 * clamp or the rounding.
 *
 * ## The bars passed in decide whether the answer is honest
 *
 * Callers must pass only the bars the position was actually alive for. Measured over a full horizon
 * instead, a candidate that stopped out on bar three would report the favourable excursion of bars it
 * never survived to see, which reads as "the target was nearly reached" about a trade that was
 * already closed.
 *
 * Returns an outcome rather than a number-or-null, because there are three distinct answers and two of
 * them are not measurements. No bars means the excursions are unknown, and zero would claim the price
 * never moved.
 *
 * ## The series must belong to the same instrument as the entry, and that used to go unchecked
 *
 * Measured 2026-09-02: every one of 339 stored trade reviews reported a favourable excursion above
 * 100R (up to 10,697R) and an adverse excursion of **exactly zero**. The cause was that
 * `paper_trades.instrument_id` points at the *index* while `entry_price` and `stop_loss` are *option
 * premiums*, so the review compared index levels against option prices: for one trade,
 * (23,980.55 - 108.75) / 8.05 = 2,965R. The adverse figure was zero on all 339 because an index low is
 * never below an option premium, and the clamp turned that into "this position never moved against
 * us" -- the single most dangerous thing a review can say wrongly, because it makes a bad stop look
 * safe.
 *
 * `SERIES_INSTRUMENT_MISMATCH` is therefore a first-class outcome. The test is that the series range
 * must not sit *entirely* on one side of the entry by more than `mismatchFactor`: the window starts at
 * the entry instant, so a series for the same instrument must either contain the entry price or come
 * close to it. A factor rather than strict containment tolerates a slightly misaligned first bar,
 * while still catching a 220x scale difference decisively.
 */
/** How far the whole series may sit off the entry before it cannot be the same instrument. */
export const excursionSeriesMismatchFactor = 5;

export type ExcursionMeasurement =
  | { readonly status: "MEASURED"; readonly excursions: Excursions }
  | { readonly status: "NO_SERIES" }
  | { readonly status: "SERIES_INSTRUMENT_MISMATCH"; readonly detail: string };

export function measureExcursions(input: {
  side: TradeSide;
  entryPrice: number;
  /** The risked distance, entry to stop. Must be positive. */
  riskPerUnit: number;
  candles: readonly ExcursionCandle[];
  /** Overridable for tests; production uses the exported default. */
  mismatchFactor?: number;
}): ExcursionMeasurement {
  if (!Number.isFinite(input.riskPerUnit) || input.riskPerUnit <= 0) {
    throw new Error("Excursion risk per unit must be a positive finite number.");
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("Excursion entry price must be a positive finite number.");
  }
  if (input.candles.length === 0) return { status: "NO_SERIES" };

  const highest = Math.max(...input.candles.map((candle) => candle.high));
  const lowest = Math.min(...input.candles.map((candle) => candle.low));

  const factor = input.mismatchFactor ?? excursionSeriesMismatchFactor;
  const entirelyAbove = lowest > input.entryPrice * factor;
  const entirelyBelow = highest * factor < input.entryPrice;
  if (entirelyAbove || entirelyBelow) {
    return {
      status: "SERIES_INSTRUMENT_MISMATCH",
      detail: `series range [${rounded(lowest)}, ${rounded(highest)}] sits entirely `
        + `${entirelyAbove ? "above" : "below"} an entry of ${rounded(input.entryPrice)} by more than `
        + `${factor}x, so it cannot be the same instrument's holding-period series`,
    };
  }
  const worstPrice = input.side === "LONG" ? lowest : highest;
  const bestPrice = input.side === "LONG" ? highest : lowest;

  // Clamped at zero: a position that never traded against the entry has no adverse excursion, and a
  // negative one would be a favourable move wearing the wrong sign.
  const maximumAdverse = rounded(Math.max(0, input.side === "LONG"
    ? input.entryPrice - worstPrice
    : worstPrice - input.entryPrice));
  const maximumFavourable = rounded(Math.max(0, input.side === "LONG"
    ? bestPrice - input.entryPrice
    : input.entryPrice - bestPrice));

  return {
    status: "MEASURED",
    excursions: {
      maximumAdverse,
      maximumFavourable,
      maximumAdverseR: rounded(maximumAdverse / input.riskPerUnit),
      maximumFavourableR: rounded(maximumFavourable / input.riskPerUnit),
    },
  };
}
