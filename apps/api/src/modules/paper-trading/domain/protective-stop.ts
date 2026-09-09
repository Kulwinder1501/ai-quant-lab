/**
 * Advancing the protective stop on an open long-premium position: break-even, then optional trail.
 *
 * Premium space and LONG only, which is not a simplification but the actual contract:
 * `decideOptionBuyerLiveExit` throws on any other side, so a bearish view bought as a PE is still
 * recorded as LONG premium and profit is always the premium rising. The break-even this replaces
 * carried a SHORT branch whose comparisons ran the other way; it was unreachable, and reproducing it
 * would have preserved a bug nothing could exercise.
 *
 * ## The trail is OFF by default, deliberately
 *
 * Exit geometry has its own registered falsification program
 * (`docs/exit-geometry-falsification-program-v1.md`), whose gate is control-adjusted edge rather
 * than gross P&L. Two measured facts say what to expect before enabling it:
 *
 *  - **Friction dominates.** 54.5% of a -76.5R book is fees; the bracket needs a 48.1% win rate and
 *    gets 35.8%. A tighter protective stop converts marginal winners into scratches that still pay a
 *    full round trip, so "it saved money" and "it traded less" are the same arithmetic here.
 *  - **Any filter looks good on a negative book.** The 15m HTF gate removed good and bad in
 *    proportion and read as an improvement purely because it reduced exposure.
 *
 * So this ships measurable and inert. Enabling it is a research decision with a gate attached, not
 * a default.
 */

export interface ProtectiveStopPolicy {
  /** Progress in R at which the stop moves to entry. */
  readonly breakEvenTriggerR: number;
  /** Null disables trailing entirely, which is the default. */
  readonly trail: {
    /** Progress in R before the trail takes over from the break-even stop. */
    readonly triggerR: number;
    /** How far below the mark the trailed stop sits, in R. */
    readonly distanceR: number;
  } | null;
}

/** Break-even at +0.5R, no trail — the behaviour that was already live. */
export const momentumScalp1mStopPolicy: ProtectiveStopPolicy = Object.freeze({
  breakEvenTriggerR: 0.5,
  trail: null,
});

export interface ProtectiveStopAdvance {
  readonly stopLoss: number;
  readonly reason: string;
}

/**
 * The new stop, or null when it should not move.
 *
 * Monotonic by construction: a candidate that does not improve on the stop currently in force is
 * refused, so this can only ever tighten. A stop that could widen would hand back risk the trade had
 * already banked, and on a re-run would make the outcome depend on the order of marks.
 */
export function advanceProtectiveStop(input: {
  readonly entryPrice: number;
  readonly initialStopLoss: number;
  readonly currentStopLoss: number;
  readonly markPremium: number;
  readonly policy: ProtectiveStopPolicy;
}): ProtectiveStopAdvance | null {
  const { entryPrice, initialStopLoss, currentStopLoss, markPremium, policy } = input;

  const risk = entryPrice - initialStopLoss;
  if (!(risk > 0) || !Number.isFinite(markPremium) || markPremium <= 0) return null;

  const progressR = (markPremium - entryPrice) / risk;

  let candidate: number | null = null;
  let reason = "";
  if (policy.trail !== null && progressR >= policy.trail.triggerR) {
    candidate = markPremium - policy.trail.distanceR * risk;
    reason = `trailed ${policy.trail.distanceR}R below the mark at +${progressR.toFixed(2)}R`;
  } else if (progressR >= policy.breakEvenTriggerR) {
    candidate = entryPrice;
    reason = `reached +${policy.breakEvenTriggerR}R, stop to break-even`;
  }
  if (candidate === null) return null;

  /*
   * A stop at or above the current mark would fire on the very tick that set it, booking an exit the
   * market never offered. Refused rather than clamped: clamping to just under the mark invents a
   * level the policy never asked for.
   */
  if (candidate >= markPremium) return null;
  if (candidate <= currentStopLoss) return null;

  return { stopLoss: candidate, reason };
}
