import type { DirectionalLabel } from "./model-competition.js";

/**
 * The directional label a forward return earns, as a single reviewable rule.
 *
 * This is the same target definition `apps/ml`'s `label_from_future_close` applies when
 * building training labels, and settlement grades live predictions with it. **Two
 * implementations of one rule is the hazard here**: they agree today (cross-checked on
 * ten boundary cases including exact thresholds), but if the trainer's band semantics
 * ever change and the settlement SQL does not, every live accuracy figure becomes
 * uninterpretable while still looking perfectly reasonable. Nothing would fail.
 *
 * So this function is not a third implementation — it is the *check*.
 * `PostgresModelPredictionSettlementRepository` re-derives every label the SQL just wrote
 * from the return the SQL itself computed, and throws when the two disagree. Silent drift
 * becomes a loud failure on the next settlement run.
 *
 * **The neutral band is inclusive**, matching the trainer: a return landing exactly on
 * either threshold is NEUTRAL, and only a return strictly beyond it commits to a
 * direction. That boundary is the part most likely to be "simplified" by a later edit,
 * which is why it is pinned by tests on both sides.
 */
export function directionalLabelFromForwardReturnBps(
  forwardReturnBps: number,
  neutralThresholdBps: number,
): DirectionalLabel {
  if (!Number.isFinite(forwardReturnBps)) {
    throw new Error("Forward return in basis points must be a finite number.");
  }
  if (!Number.isFinite(neutralThresholdBps) || neutralThresholdBps < 0) {
    throw new Error("Neutral threshold in basis points must be a finite, non-negative number.");
  }
  if (forwardReturnBps > neutralThresholdBps) return "BULLISH";
  if (forwardReturnBps < -neutralThresholdBps) return "BEARISH";
  return "NEUTRAL";
}
