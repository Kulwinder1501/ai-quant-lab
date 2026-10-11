/**
 * Liquidity Intelligence Engine v1 — Phase 3 & 4: Empirical Geometry Scorer
 *
 * Implements the out-of-sample validated Logistic Regression scoring function
 * derived from the Phase 3 & Phase 4 empirical study over BANKNIFTY historical candidates.
 *
 * Performance Validation (Out-of-Sample Test Set):
 *   - 2m Horizon (120s):  ROC-AUC = 0.9262, PR-AUC = 0.8501, Log Loss = 0.3014
 *   - 5m Horizon (300s):  ROC-AUC = 0.9361, PR-AUC = 0.9205, Log Loss = 0.2733
 *
 * Proves that observable pool level geometry (distance in bps, pool identity, side, session context)
 * provides > 93% predictive power for near-term liquidity pool contact.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ WARNING -- TRAINED ON LEAKY LEGACY LABELS (`labeling_version = 'v1-legacy'`). DO NOT     ║
 * ║ TRUST THE AUC / PROBABILITIES BELOW.                                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 * The weights and the "AUC 0.93" were fitted on `liquidity_contact_labels` produced by the
 * defective legacy labeler: its forward window started at the OPEN of the confirming bar, so the
 * confirming bar itself was credited as "contact" (5m SESSION_HIGH/LOW: 5646 of 5646 contacted),
 * and the "30s" horizon was really a 60s span from 1m bars. The candidates were also massively
 * duplicated after PDH/PDL breaches (one level-day -> up to 1,725 rows). The large positive
 * SESSION_HIGH/LOW weights below largely encode that leakage (the level IS the bar that was just
 * traded), not market behaviour. This scorer has NOT been retrained on `v2-causal` labels over
 * `v2-dedup` candidates -- see `liquidity-label-versions.ts` and
 * docs/2026-10-10-orderbook-liquidity-audit-fixes.md. Consumers can detect this programmatically
 * through `GEOMETRY_SCORER_TRAINED_ON_LABELING_VERSION` / `GEOMETRY_SCORER_IS_TRAINED_ON_LEGACY_LABELS`
 * and every score carries `trainedOnLabelingVersion`.
 */

import { LABELING_VERSION_LEGACY } from "./liquidity-label-versions.js";

/** The labeling_version the weights below were fitted on. NOT `v2-causal`: they are not retrained. */
export const GEOMETRY_SCORER_TRAINED_ON_LABELING_VERSION = LABELING_VERSION_LEGACY;
/** True while the weights come from the leaky legacy labels; flips only when retrained on v2-causal. */
export const GEOMETRY_SCORER_IS_TRAINED_ON_LEGACY_LABELS = true;

export type LiquidityPoolType =
  | "PDH"
  | "PDL"
  | "SESSION_HIGH"
  | "SESSION_LOW"
  | "SWING_HIGH"
  | "SWING_LOW"
  | "ITH"
  | "ITL";

export type LiquiditySide = "UP" | "DOWN";

export interface ScoreLiquidityGeometryInput {
  readonly poolType: LiquidityPoolType | string;
  readonly side: LiquiditySide;
  readonly distanceBps: number;
  readonly timeframe: string;
  readonly minutesIntoSession: number;
  readonly horizonSeconds?: 120 | 300;
}

export interface LiquidityGeometryScore {
  readonly predictedContactProbability: number;
  readonly probabilityBucket: "HIGH" | "MEDIUM" | "LOW";
  readonly isFavorableForContact: boolean;
  readonly poolType: string;
  readonly side: LiquiditySide;
  readonly distanceBps: number;
  readonly horizonSeconds: number;
  readonly rationale: string;
  /** Always the legacy (leaky) labeling version until the scorer is retrained; see the file header. */
  readonly trainedOnLabelingVersion: string;
  readonly isTrainedOnLegacyLabels: boolean;
}

/**
 * Logistic regression weights for 300s horizon (Stage B baseline).
 * Derived from Phase 3 train dataset (Jan 2026 - Jun 2026) on LEGACY (`v1-legacy`) labels, which
 * leak look-ahead -- see the warning in the file header. Not calibrated on causal labels.
 */
const INTERCEPT_300S = 2.45;
const COEFF_LOG_DIST_300S = -1.82; // Distance decay
const COEFF_SESSION_TIME_300S = 0.45;

const POOL_TYPE_WEIGHTS_300S: Record<string, number> = {
  SESSION_HIGH: 3.85,
  SESSION_LOW: 3.72,
  PDH: 1.15,
  PDL: 1.08,
  ITH: 0.25,
  ITL: 0.18,
  SWING_HIGH: -0.45,
  SWING_LOW: -0.52,
};

const SIDE_WEIGHTS_300S: Record<LiquiditySide, number> = {
  UP: 0.05,
  DOWN: -0.05,
};

export class LiquidityGeometryScorer {
  /**
   * Scores the probability of price contacting a liquidity candidate pool within horizon.
   */
  score(input: ScoreLiquidityGeometryInput): LiquidityGeometryScore {
    const horizon = input.horizonSeconds ?? 300;
    const distBps = Math.max(0.0, input.distanceBps);
    const logDist = Math.log1p(distBps);

    // Session time normalized to [0, 1] over 375-minute trading day (09:15 to 15:30)
    const normalizedSessionTime = Math.max(0.0, Math.min(1.0, input.minutesIntoSession / 375.0));

    const poolWeight = POOL_TYPE_WEIGHTS_300S[input.poolType] ?? 0.0;
    const sideWeight = SIDE_WEIGHTS_300S[input.side] ?? 0.0;

    // Log-odds score
    const z = INTERCEPT_300S
      + COEFF_LOG_DIST_300S * logDist
      + poolWeight
      + sideWeight
      + COEFF_SESSION_TIME_300S * normalizedSessionTime;

    // Sigmoid transformation
    const prob = 1.0 / (1.0 + Math.exp(-z));
    const predictedContactProbability = Number(Math.max(0.01, Math.min(0.99, prob)).toFixed(4));

    let probabilityBucket: "HIGH" | "MEDIUM" | "LOW" = "LOW";
    if (predictedContactProbability >= 0.70) {
      probabilityBucket = "HIGH";
    } else if (predictedContactProbability >= 0.35) {
      probabilityBucket = "MEDIUM";
    }

    const isFavorableForContact = predictedContactProbability >= 0.50;

    const rationale = `Liquidity candidate ${input.poolType} (${input.side}) at ${distBps.toFixed(1)} bps distance has ${(predictedContactProbability * 100).toFixed(1)}% predicted contact probability within ${horizon}s (${probabilityBucket} bucket).`;

    return {
      predictedContactProbability,
      probabilityBucket,
      isFavorableForContact,
      poolType: input.poolType,
      side: input.side,
      distanceBps: distBps,
      horizonSeconds: horizon,
      rationale,
      trainedOnLabelingVersion: GEOMETRY_SCORER_TRAINED_ON_LABELING_VERSION,
      isTrainedOnLegacyLabels: GEOMETRY_SCORER_IS_TRAINED_ON_LEGACY_LABELS,
    };
  }
}
