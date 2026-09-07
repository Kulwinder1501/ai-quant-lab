export interface CausalCandle {
  readonly id: string;
  readonly openTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ConfirmedPivot {
  readonly index: number; // Index of the candle where the pivot occurred
  readonly time: Date;
  readonly price: number;
  readonly type: "HIGH" | "LOW";
  readonly confirmedAtIndex: number; // The bar index at which the pivot was confirmed strictly causally
  readonly confirmedAtTime: Date;
}

export interface ConfirmedPivotPair {
  readonly high: ConfirmedPivot | null;
  readonly low: ConfirmedPivot | null;
}

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
        }
      : null,
  };
}
