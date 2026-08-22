import type { ForwardPath, ForwardSegment } from "./forward-path.js";

/**
 * Six Label Families for Directional Intelligence V2 (Phase 29 §4).
 *
 * Implements:
 * - D0-A: Adaptive Fixed Horizon
 * - D0-B: Triple Barrier (Dynamic symmetric barriers, ambiguity tracking)
 * - D0-C: Signed Path Efficiency (Kaufman Efficiency Ratio, zero-floor protection)
 * - D0-D: Continuous Return (D0-D1 Raw Return, D0-D2 Vol-Normalized Return)
 * - D0-E: Move-then-Side Decomposition (Stage 1 MOVE, Stage 2 SIDE|MOVE)
 */

export const PATH_FLOOR_BPS = 1.0;

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite.`);
  return value;
}

// --- D0-A: Adaptive Fixed Horizon -------------------------------------------

export type DirectionLabel = "UP" | "DOWN" | "NEUTRAL";

export interface AdaptiveLabelOutcome {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly futureReturnBps: number;
  readonly expectedVolBps: number;
  readonly futureReturnVolUnits: number;
  readonly label: DirectionLabel;
  readonly kMultiplier: number;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export function labelAdaptiveFixedHorizon(
  segment: ForwardSegment,
  expectedVolBps: number,
  kMultiplier = 0.5,
): AdaptiveLabelOutcome {
  const safeVol = positiveFinite(expectedVolBps, "expectedVolBps");
  positiveFinite(kMultiplier, "kMultiplier");
  const futureReturnVolUnits = segment.cumulativeReturnBps / safeVol;

  let label: DirectionLabel = "NEUTRAL";
  if (futureReturnVolUnits >= kMultiplier) {
    label = "UP";
  } else if (futureReturnVolUnits <= -kMultiplier) {
    label = "DOWN";
  }

  return {
    horizonMinutes: segment.horizonMinutes,
    futureReturnBps: segment.cumulativeReturnBps,
    expectedVolBps,
    futureReturnVolUnits,
    label,
    kMultiplier,
    labelStartAt: segment.labelStartAt,
    labelEndAt: segment.labelEndAt,
  };
}

// --- D0-B: Triple Barrier ---------------------------------------------------

export type BarrierOutcome = "UPPER" | "LOWER" | "TIME" | "AMBIGUOUS";

export interface TripleBarrierOutcome {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly barrierOutcome: BarrierOutcome;
  readonly upperBarrierBps: number;
  readonly lowerBarrierBps: number;
  readonly isAmbiguous: boolean;
  readonly hitBarIndex: number | null; // index of the 1m bar that touched a barrier
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export function labelTripleBarrier(
  path: ForwardPath,
  segment: ForwardSegment,
  expectedVolBps: number,
  barrierMultiplier = 1.0,
): TripleBarrierOutcome {
  positiveFinite(expectedVolBps, "expectedVolBps");
  positiveFinite(barrierMultiplier, "barrierMultiplier");
  const upperBarrierBps = barrierMultiplier * expectedVolBps;
  const lowerBarrierBps = -barrierMultiplier * expectedVolBps;
  const refPrice = path.referencePrice;

  // Filter candles up to the segment's end time
  const targetEndMs = segment.labelEndAt.getTime();
  const candles = path.forward1mCandles.filter((c) => c.closeTime.getTime() <= targetEndMs);

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const highBps = 10_000 * Math.log(candle.high / refPrice);
    const lowBps = 10_000 * Math.log(candle.low / refPrice);

    const hitUpper = highBps >= upperBarrierBps;
    const hitLower = lowBps <= lowerBarrierBps;

    if (hitUpper && hitLower) {
      // Both barriers touched within the same 1m candle -> Ambiguous ordering
      return {
        horizonMinutes: segment.horizonMinutes,
        barrierOutcome: "AMBIGUOUS",
        upperBarrierBps,
        lowerBarrierBps,
        isAmbiguous: true,
        hitBarIndex: index,
        labelStartAt: segment.labelStartAt,
        labelEndAt: candle.closeTime,
      };
    }

    if (hitUpper) {
      return {
        horizonMinutes: segment.horizonMinutes,
        barrierOutcome: "UPPER",
        upperBarrierBps,
        lowerBarrierBps,
        isAmbiguous: false,
        hitBarIndex: index,
        labelStartAt: segment.labelStartAt,
        labelEndAt: candle.closeTime,
      };
    }

    if (hitLower) {
      return {
        horizonMinutes: segment.horizonMinutes,
        barrierOutcome: "LOWER",
        upperBarrierBps,
        lowerBarrierBps,
        isAmbiguous: false,
        hitBarIndex: index,
        labelStartAt: segment.labelStartAt,
        labelEndAt: candle.closeTime,
      };
    }
  }

  // No barrier touched before timeout -> Time expiry
  return {
    horizonMinutes: segment.horizonMinutes,
    barrierOutcome: "TIME",
    upperBarrierBps,
    lowerBarrierBps,
    isAmbiguous: false,
    hitBarIndex: null,
    labelStartAt: segment.labelStartAt,
    labelEndAt: segment.labelEndAt,
  };
}

// --- D0-C: Signed Path Efficiency -------------------------------------------

export interface PathEfficiencyOutcome {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly signedPathEfficiency: number; // -1 to +1
  readonly absolutePathEfficiency: number; // 0 to 1
  readonly signedEfficiency5m: number; // sensitivity version sampled at 5m steps
  readonly netReturnBps: number;
  readonly totalPathMovement1mBps: number;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export function labelPathEfficiency(
  path: ForwardPath,
  segment: ForwardSegment,
  pathFloorBps = PATH_FLOOR_BPS,
): PathEfficiencyOutcome {
  if (!Number.isFinite(pathFloorBps) || pathFloorBps < 0) throw new Error("pathFloorBps must be finite and non-negative.");
  const targetEndMs = segment.labelEndAt.getTime();
  const candles = path.forward1mCandles.filter((c) => c.closeTime.getTime() <= targetEndMs);

  let totalPathMovement1mBps = 0;
  let prevPrice = path.referencePrice;

  for (const candle of candles) {
    totalPathMovement1mBps += Math.abs(10_000 * Math.log(candle.close / prevPrice));
    prevPrice = candle.close;
  }

  const netReturnBps = segment.cumulativeReturnBps;
  let signedPathEfficiency = 0;
  if (totalPathMovement1mBps > pathFloorBps) {
    signedPathEfficiency = Math.max(-1.0, Math.min(1.0, netReturnBps / totalPathMovement1mBps));
  }

  // 5m-resampled sensitivity version
  let totalPath5mBps = 0;
  let prev5mPrice = path.referencePrice;
  for (let i = 4; i < candles.length; i += 5) {
    const candle5m = candles[i]!;
    totalPath5mBps += Math.abs(10_000 * Math.log(candle5m.close / prev5mPrice));
    prev5mPrice = candle5m.close;
  }
  // Include remainder if any
  if (candles.length > 0 && candles.length % 5 !== 0) {
    const last = candles[candles.length - 1]!;
    totalPath5mBps += Math.abs(10_000 * Math.log(last.close / prev5mPrice));
  }

  let signedEfficiency5m = 0;
  if (totalPath5mBps > pathFloorBps) {
    signedEfficiency5m = Math.max(-1.0, Math.min(1.0, netReturnBps / totalPath5mBps));
  }

  return {
    horizonMinutes: segment.horizonMinutes,
    signedPathEfficiency,
    absolutePathEfficiency: Math.abs(signedPathEfficiency),
    signedEfficiency5m,
    netReturnBps,
    totalPathMovement1mBps,
    labelStartAt: segment.labelStartAt,
    labelEndAt: segment.labelEndAt,
  };
}

// --- D0-D: Continuous Return Prediction -------------------------------------

export interface ContinuousReturnOutcome {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly rawReturnBps: number; // D0-D1
  readonly volNormalizedReturn: number; // D0-D2 (futureReturnBps / expectedVolBps)
  readonly expectedVolBps: number;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export function labelContinuousReturn(
  segment: ForwardSegment,
  expectedVolBps: number,
): ContinuousReturnOutcome {
  const safeVol = positiveFinite(expectedVolBps, "expectedVolBps");
  const rawReturnBps = segment.cumulativeReturnBps;
  const volNormalizedReturn = rawReturnBps / safeVol;

  return {
    horizonMinutes: segment.horizonMinutes,
    rawReturnBps,
    volNormalizedReturn,
    expectedVolBps,
    labelStartAt: segment.labelStartAt,
    labelEndAt: segment.labelEndAt,
  };
}

// --- D0-E: Move-then-Side Decomposition -------------------------------------

export type MoveSide = "UP" | "DOWN";

export interface MoveThenSideOutcome {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly moveLabel: 0 | 1; // Stage 1: Did a meaningful move happen?
  readonly sideLabel: MoveSide | null; // Stage 2: If move happened, which direction?
  readonly futureReturnBps: number;
  readonly expectedVolBps: number;
  readonly futureReturnVolUnits: number;
  readonly kMultiplier: number;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export function labelMoveThenSide(
  segment: ForwardSegment,
  expectedVolBps: number,
  kMultiplier = 0.5,
): MoveThenSideOutcome {
  const safeVol = positiveFinite(expectedVolBps, "expectedVolBps");
  positiveFinite(kMultiplier, "kMultiplier");
  const futureReturnVolUnits = segment.cumulativeReturnBps / safeVol;
  const isMove = Math.abs(futureReturnVolUnits) >= kMultiplier;

  const moveLabel = isMove ? 1 : 0;
  const sideLabel: MoveSide | null = isMove
    ? (segment.cumulativeReturnBps >= 0 ? "UP" : "DOWN")
    : null;

  return {
    horizonMinutes: segment.horizonMinutes,
    moveLabel,
    sideLabel,
    futureReturnBps: segment.cumulativeReturnBps,
    expectedVolBps,
    futureReturnVolUnits,
    kMultiplier,
    labelStartAt: segment.labelStartAt,
    labelEndAt: segment.labelEndAt,
  };
}

/**
 * Reconstructs unconditional probabilities from Stage 1 (pMove) and Stage 2 (pUpGivenMove).
 * Phase 29 Invariant: Prevents selection bias from making D0-E look artificially superior.
 */
export function reconstructMoveSideProbabilities(
  pMove: number,
  pUpGivenMove: number,
): { pUp: number; pDown: number; pNeutral: number; directionalScore: number } {
  const clampedMove = Math.max(0, Math.min(1, pMove));
  const clampedUpGivenMove = Math.max(0, Math.min(1, pUpGivenMove));

  const pUp = clampedMove * clampedUpGivenMove;
  const pDown = clampedMove * (1 - clampedUpGivenMove);
  const pNeutral = 1 - clampedMove;
  const directionalScore = pUp - pDown;

  return { pUp, pDown, pNeutral, directionalScore };
}
