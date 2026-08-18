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
 * Returns null for an empty window rather than zeroes: no bars means the excursions are unknown, and
 * zero would claim the price never moved.
 */
export function measureExcursions(input: {
  side: TradeSide;
  entryPrice: number;
  /** The risked distance, entry to stop. Must be positive. */
  riskPerUnit: number;
  candles: readonly ExcursionCandle[];
}): Excursions | null {
  if (!Number.isFinite(input.riskPerUnit) || input.riskPerUnit <= 0) {
    throw new Error("Excursion risk per unit must be a positive finite number.");
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("Excursion entry price must be a positive finite number.");
  }
  if (input.candles.length === 0) return null;

  const highest = Math.max(...input.candles.map((candle) => candle.high));
  const lowest = Math.min(...input.candles.map((candle) => candle.low));
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
    maximumAdverse,
    maximumFavourable,
    maximumAdverseR: rounded(maximumAdverse / input.riskPerUnit),
    maximumFavourableR: rounded(maximumFavourable / input.riskPerUnit),
  };
}
