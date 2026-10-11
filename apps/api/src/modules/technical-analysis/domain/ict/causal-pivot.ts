import type { IctCausalEvent } from "./zones.js";

export interface CausalCandle {
  readonly id: string;
  readonly openTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ConfirmedPivot extends IctCausalEvent {
  readonly index: number; // Index of the candle where the pivot occurred
  readonly time: Date;
  readonly price: number;
  readonly type: "HIGH" | "LOW";
  readonly confirmedAtIndex: number; // The bar index at which the pivot was confirmed strictly causally
  readonly confirmedAtTime: Date;
  readonly availableAt: number;
}

export interface ConfirmedPivotPair {
  readonly high: ConfirmedPivot | null;
  readonly low: ConfirmedPivot | null;
}

/**
 * A note on every `availableAt` / `confirmedAt` stamp in this module family.
 *
 * They are the OPEN time of the bar whose close revealed the fact, not that bar's close time.
 * That is a labelling convention, not a look-ahead: the whole ICT engine runs on COMPLETE bars
 * only, so a pivot stamped with the confirming bar's open is first visible when that bar has
 * closed, which is exactly when the engine and the strategy evaluate it. Every consumer compares
 * against an instant on the SAME bar (`liquidity.ts` against `current.openTime`; the strategy's
 * point-in-time check against `candle.closeTime`), so a fact is never visible one bar early.
 *
 * What would break the convention is evaluating mid-bar. Do not feed this engine a forming candle;
 * `availableAt` would then admit a pivot whose confirming bar has not closed.
 */

/**
 * Strictly causal pivot identification.
 *
 * A pivot at candidateIndex = knownAtIndex - pivotLength is confirmed only when:
 * 1) candidateIndex >= pivotLength (has full left wing)
 * 2) knownAtIndex >= candidateIndex + pivotLength (has full right wing closed)
 * 3) candidate high/low strictly exceeds (or is strictly below) all pivotLength bars on left & right.
 *
 * The pivot is published/known AT knownAtIndex (the right-wing closing bar), never at candidateIndex.
 */
export function findConfirmedPivotAt(
  candles: readonly CausalCandle[],
  knownAtIndex: number,
  pivotLength: number
): ConfirmedPivotPair {
  const candidateIndex = knownAtIndex - pivotLength;
  if (candidateIndex < pivotLength || knownAtIndex >= candles.length) {
    return { high: null, low: null };
  }

  const candidate = candles[candidateIndex];
  let isSwingHigh = true;
  let isSwingLow = true;

  for (let offset = 1; offset <= pivotLength; offset += 1) {
    const left = candles[candidateIndex - offset];
    const right = candles[candidateIndex + offset];

    if (left.high >= candidate.high || right.high >= candidate.high) {
      isSwingHigh = false;
    }
    if (left.low <= candidate.low || right.low <= candidate.low) {
      isSwingLow = false;
    }
  }

  const confirmedBar = candles[knownAtIndex];

  return {
    high: isSwingHigh
      ? {
          index: candidateIndex,
          time: candidate.openTime,
          price: candidate.high,
          type: "HIGH",
          confirmedAtIndex: knownAtIndex,
          confirmedAtTime: confirmedBar.openTime,
          candidateAt: candidate.openTime.getTime(),
          formedAt: candidate.openTime.getTime(),
          confirmedAt: confirmedBar.openTime.getTime(),
          availableAt: confirmedBar.openTime.getTime(),
        }
      : null,
    low: isSwingLow
      ? {
          index: candidateIndex,
          time: candidate.openTime,
          price: candidate.low,
          type: "LOW",
          confirmedAtIndex: knownAtIndex,
          confirmedAtTime: confirmedBar.openTime,
          candidateAt: candidate.openTime.getTime(),
          formedAt: candidate.openTime.getTime(),
          confirmedAt: confirmedBar.openTime.getTime(),
          availableAt: confirmedBar.openTime.getTime(),
        }
      : null,
  };
}
