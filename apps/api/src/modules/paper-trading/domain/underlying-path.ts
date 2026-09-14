import { measureExcursions, type ExcursionCandle } from "./excursions.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/**
 * Whether the underlying reached a thesis barrier during the hold, and which one it touched first.
 *
 * ## Why the endpoint alone was not enough
 *
 * Measured 2026-09-02 across 22 closed trades carrying an observed underlying exit: not one resolved
 * its thesis. 21 finished between their stop and target and one finished through its stop, so
 * `TARGET_REACHED` had never once occurred -- which made `attributeShortfall`'s `INSTRUMENT` verdict
 * unreachable, since it requires exactly that. `INSTRUMENT` is the verdict that says "the thesis was
 * right and the expression was wrong", so its absence was not a happy finding; it meant the
 * three-layer split could not answer the question it exists for.
 *
 * Two mechanisms produced it, and only the second is fixable here:
 *
 *   1. The option's own target sits much nearer than the thesis target -- it fired at 18-53% of the
 *      distance -- so the position closes before the underlying arrives.
 *   2. Resolution read only the exit instant. A target touched mid-hold and given back was invisible.
 *
 * This addresses (2). The underlying's path is available and was simply unread: a paper trade's
 * `instrument_id` points at the *index*, so its own 1m candles cover the whole holding period.
 *
 * ## `TARGET_REACHED` from a path means "touched", and that is weaker
 *
 * Candle extremes are an upper bound: a target credited from a 1m high may have been a wick nobody
 * could have exited on. So a path-derived resolution is a weaker claim than a close through the
 * level, and `resolutionBasis` records which kind a reader holds. 1m is used because it is the finest
 * series stored, and the bound tightens with the timeframe.
 *
 * ## Stop-first within a bar, deliberately
 *
 * Order comes from bar order: the first bar to touch either level decides. When a single bar's range
 * spans both, the intrabar path is unknowable and the tie goes to the stop. That matches
 * `decidePaperTradeExit`'s existing `CONSERVATIVE_STOP_FIRST` convention, and it is the conservative
 * direction for attribution -- crediting the target on an ambiguous bar would manufacture
 * `INSTRUMENT` verdicts ("the thesis was right") out of bars that may never have got there.
 */

export type UnderlyingBarrierTouch = "TARGET" | "STOP" | null;

export interface UnderlyingPathBar extends ExcursionCandle {
  readonly openTime: Date;
}

export interface UnderlyingPath {
  /** Furthest the underlying ran in favour of the thesis, in points. Never negative. */
  readonly favourableExcursion: number;
  readonly adverseExcursion: number;
  readonly excursionTimeframe: string;
  /** Which barrier the underlying touched first, or null if it touched neither. */
  readonly firstTouch: UnderlyingBarrierTouch;
  readonly barsRead: number;
}

export interface UnderlyingThesisLevels {
  readonly direction: TradeSide;
  readonly entryReference: number;
  readonly stop: number;
  readonly target: number;
}

/**
 * Returns null when there is nothing to measure, or when the bars cannot be the thesis instrument's.
 *
 * The mismatch case reuses `measureExcursions`' sentinel: it was added after index levels were
 * measured against option premiums for 339 reviews, and it applies here for the same reason -- if a
 * caller passed option bars for an underlying thesis, the excursions would be nonsense of exactly
 * the kind that reads as a real measurement.
 */
export function resolveUnderlyingPath(input: {
  readonly thesis: UnderlyingThesisLevels;
  readonly bars: readonly UnderlyingPathBar[];
  readonly timeframe: string;
}): UnderlyingPath | null {
  const { thesis, bars } = input;
  if (bars.length === 0) return null;

  const riskPerUnit = Math.abs(thesis.entryReference - thesis.stop);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;

  const measured = measureExcursions({
    side: thesis.direction,
    entryPrice: thesis.entryReference,
    riskPerUnit,
    candles: bars,
  });
  if (measured.status !== "MEASURED") return null;

  const longThesis = thesis.direction === "LONG";
  let firstTouch: UnderlyingBarrierTouch = null;
  for (const bar of [...bars].sort((a, b) => a.openTime.getTime() - b.openTime.getTime())) {
    const touchedStop = longThesis ? bar.low <= thesis.stop : bar.high >= thesis.stop;
    const touchedTarget = longThesis ? bar.high >= thesis.target : bar.low <= thesis.target;
    // Stop first on an ambiguous bar: the intrabar path is unknowable, and crediting the target
    // would manufacture "the thesis was right" from a bar that may never have reached it.
    if (touchedStop) { firstTouch = "STOP"; break; }
    if (touchedTarget) { firstTouch = "TARGET"; break; }
  }

  return {
    favourableExcursion: measured.excursions.maximumFavourable,
    adverseExcursion: measured.excursions.maximumAdverse,
    excursionTimeframe: input.timeframe,
    firstTouch,
    barsRead: bars.length,
  };
}
