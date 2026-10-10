/**
 * Liquidity Intelligence Engine v1 — Component C: Liquidity Response Resolver
 *
 * Evaluates the market's response upon contacting an identified liquidity pool:
 *   - SWEEP_REJECTION: Price sweeps liquidity and reclaims back inside the range.
 *   - BREAK_ACCEPTANCE: Price breaches through the pool and accepts beyond it.
 *   - AMBIGUOUS: Indeterminate or insufficient excursion to classify.
 *
 * CAVEAT (2026-10-10): none of the numbers in this file are validated.
 *   - The baseline rejection priors below came from the Phase 4 study run on the LEGACY
 *     (`labeling_version = 'v1-legacy'`) contact labels, whose forward window included the
 *     confirming bar (look-ahead; e.g. 5m SESSION_HIGH/LOW 5646/5646 "contacted", 0 breached) and
 *     whose candidates were duplicated after PDH/PDL breaches. Treat them as unverified priors.
 *   - The additive adjustments in `evaluate()` (+0.05 shallow graze, -0.15 heavy penetration,
 *     +0.10 strong reclaim, -0.25 no close-back-inside) and the 0.70 / 0.60 verdict cut-offs are
 *     UNVALIDATED HEURISTICS: hand-picked constants, never fitted or calibrated against any
 *     outcome. They are kept as-is and are NOT a calibration -- do not quote the resulting
 *     "probabilities" as measured rejection rates.
 *
 * Original (uncalibrated) description of the Phase 4 study over BANKNIFTY history:
 *   - SWING_HIGH / SWING_LOW: ~88% - 90% Rejection Rate (High-Probability Sweep)
 *   - ITH / ITL:             ~84% - 90% Rejection Rate (High-Probability Sweep)
 *   - SESSION_HIGH / LOW:    ~86% - 88% Rejection Rate
 *   - PDH / PDL:             ~62% - 67% Acceptance Rate (Breakout-Dominated)
 *
 * This resolver prevents the catastrophic "PDH Sweep Reversal" trap where trading
 * bots buy/sell into a 65% breakout momentum, while directing sweep capital to
 * structural pivots where rejection rates exceed 85%.
 */

export type LiquidityResponseVerdict =
  | "SWEEP_REJECTION"
  | "BREAK_ACCEPTANCE"
  | "AMBIGUOUS";

export interface LiquidityResponseAssessment {
  readonly verdict: LiquidityResponseVerdict;
  readonly rejectionProbability: number;
  readonly acceptanceProbability: number;
  readonly isFavorableForSweep: boolean;
  readonly isFavorableForBreakout: boolean;
  readonly poolType: string;
  readonly rationale: string;
}

export interface EvaluateResponseInput {
  readonly poolType:
    | "PDH"
    | "PDL"
    | "SESSION_HIGH"
    | "SESSION_LOW"
    | "SWING_HIGH"
    | "SWING_LOW"
    | "ITH"
    | "ITL"
    | string;
  readonly side: "UP" | "DOWN";
  readonly penetrationBps: number;
  readonly reclaimDistanceBps: number;
  readonly isClosedBackInside: boolean;
}

/**
 * Baseline rejection priors from Phase 4 research on LEGACY (look-ahead) labels -- unverified.
 * See the caveat in the file header.
 */
const BASELINE_REJECTION_PRIORS: Record<string, number> = {
  SWING_LOW: 0.90,
  ITL: 0.895,
  SWING_HIGH: 0.881,
  SESSION_LOW: 0.879,
  SESSION_HIGH: 0.863,
  ITH: 0.842,
  PDH: 0.375,
  PDL: 0.326,
};

export class LiquidityResponseResolver {
  /**
   * Assesses whether a liquidity contact event is favorable for a Sweep Reversal
   * or a Breakout Continuation.
   */
  evaluate(input: EvaluateResponseInput): LiquidityResponseAssessment {
    const basePrior = BASELINE_REJECTION_PRIORS[input.poolType] ?? 0.50;
    let adjustedRejection = basePrior;

    // UNVALIDATED HEURISTIC ADJUSTMENTS (+0.05 / -0.15 / +0.10 / -0.25 below): hand-picked
    // constants, not calibrated against any outcome. See the file header.
    // Heavy penetration (> 15 bps) indicates aggressive momentum; penalizes sweep probability.
    if (input.penetrationBps > 15) {
      adjustedRejection -= 0.15;
    } else if (input.penetrationBps <= 5) {
      // Shallow penetration (clean graze/wick) supports sweep thesis.
      adjustedRejection += 0.05;
    }

    // Strong reclaim distance back inside the level confirms absorption.
    if (input.reclaimDistanceBps >= 10 && input.isClosedBackInside) {
      adjustedRejection += 0.10;
    } else if (!input.isClosedBackInside) {
      // Failed to close back inside: severe penalty for rejection.
      adjustedRejection -= 0.25;
    }

    // Bounded in [0.01, 0.99]
    adjustedRejection = Math.max(0.01, Math.min(0.99, Number(adjustedRejection.toFixed(4))));
    const adjustedAcceptance = Number((1.0 - adjustedRejection).toFixed(4));

    let verdict: LiquidityResponseVerdict = "AMBIGUOUS";
    if (adjustedRejection >= 0.70 && input.isClosedBackInside) {
      verdict = "SWEEP_REJECTION";
    } else if (adjustedAcceptance >= 0.60 && !input.isClosedBackInside) {
      verdict = "BREAK_ACCEPTANCE";
    }

    const isFavorableForSweep = verdict === "SWEEP_REJECTION";
    const isFavorableForBreakout = verdict === "BREAK_ACCEPTANCE";

    let rationale: string;
    if (isFavorableForSweep) {
      rationale = `High-probability sweep on ${input.poolType} (${(adjustedRejection * 100).toFixed(1)}% rejection probability). Price swept ${input.penetrationBps.toFixed(1)} bps and reclaimed ${input.reclaimDistanceBps.toFixed(1)} bps inside.`;
    } else if (isFavorableForBreakout) {
      rationale = `Breakout acceptance favored on ${input.poolType} (${(adjustedAcceptance * 100).toFixed(1)}% breakout probability). Level penetrated by ${input.penetrationBps.toFixed(1)} bps without reclaim. Reversal entries strictly prohibited.`;
    } else {
      rationale = `Ambiguous response on ${input.poolType} (Rejection ${(adjustedRejection * 100).toFixed(1)}%, Acceptance ${(adjustedAcceptance * 100).toFixed(1)}%). Waiting for clear structural reclaim.`;
    }

    return {
      verdict,
      rejectionProbability: adjustedRejection,
      acceptanceProbability: adjustedAcceptance,
      isFavorableForSweep,
      isFavorableForBreakout,
      poolType: input.poolType,
      rationale,
    };
  }
}
