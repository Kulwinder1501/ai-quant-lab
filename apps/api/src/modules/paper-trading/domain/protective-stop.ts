/**
 * Advancing the protective stop on an open long-premium position: break-even, then optional trail.
 *
 * Premium space and LONG only, which is not a simplification but the actual contract:
 * `decideOptionBuyerLiveExit` throws on any other side, so a bearish view bought as a PE is still
 * recorded as LONG premium and profit is always the premium rising. The break-even this replaces
 * carried a SHORT branch whose comparisons ran the other way; it was unreachable, and reproducing it
 * would have preserved a bug nothing could exercise.
 *
 * ## Break-even landed one tick short of entry, not on it
 *
 * `paper_trades_check` requires `stop_loss < entry_price` for a LONG, strictly. Moving the stop to
 * exactly `entryPrice` -- the textbook definition of break-even -- fails that constraint every time:
 * confirmed live, 2026-09-21, `AutoBot-Scalp1m` BANKNIFTY trade `83a48450...` reached +0.99R, tried
 * and failed to advance on every sweep from the moment it crossed +0.5R, and rode the reversal to
 * its original stop for a full loss instead of a near-scratch. `evaluationFailures` recorded
 * `violates check constraint "paper_trades_check"` on every attempt; nothing crashed, so this went
 * unnoticed. One tick short of entry is the closest value the schema actually allows, and it still
 * captures effectively all of the intended protection -- the residual risk is one tick's worth of
 * premium, not the full original stop distance.
 *
 * The same floor applies to the trail branch below, defensively: `trail` is off by default today, but
 * a trailed stop that reaches or passes `entryPrice` would hit the identical constraint the moment
 * trailing is ever enabled. Whether a LONG's stop should ever be allowed to sit *above* entry (a real
 * profit lock, not break-even) is a schema question for that future decision, not this fix -- until
 * then this floors at the same one-tick-below-entry ceiling break-even uses.
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
 *
 * ## Break-even is OFF too, as of 2026-09-21 -- it backtested worse, not better
 *
 * The one-tick-below-entry fix above made break-even *able* to persist for the first time. Before
 * shipping that live, it got the same backtest-first treatment as everything else this month
 * (`underlying-protective-stop.ts`, same cohort, real costs): NIFTY50 -49.22 -> -49.47/trade
 * (t=-1.86), BANKNIFTY -63.08 -> -64.03/trade (t=-2.63, clearing this project's own significance
 * bar in the *negative* direction). The trail config proposed alongside it (+0.8R trigger, 0.3R
 * behind peak) changed nothing beyond break-even -- it never once activated on this data.
 *
 * The mechanism why: this bot barely wins at all, and the rare trades that do reach target often
 * dip back through +0.5R first on the way there -- ordinary noise, not a reversal. Break-even cuts
 * exactly those trades short into scratches. It does nothing for the trades that were always going
 * to lose, since they never reach +0.5R. On a book this lopsided it can only cost winners, never
 * save losers. `breakEvenTriggerR: null` below reflects that finding, not an oversight -- do not
 * re-enable it without a new registered result that overturns this one.
 */

import { OPTION_TICK_SIZE } from "../../pricing/domain/option-tick.js";

export interface ProtectiveStopPolicy {
  /** Progress in R at which the stop moves to entry. Null disables break-even entirely. */
  readonly breakEvenTriggerR: number | null;
  /** Null disables trailing entirely, which is the default. */
  readonly trail: {
    /** Progress in R before the trail takes over from the break-even stop. */
    readonly triggerR: number;
    /** How far below the mark the trailed stop sits, in R. */
    readonly distanceR: number;
  } | null;
}

/**
 * Fully inert as of 2026-09-21: break-even backtested worse than doing nothing (see the file
 * docstring), so both stages are off. Not the "behaviour that was already live" any more -- that
 * break-even was live in name only, since it never actually persisted (the bug this file's fix
 * addresses); this is the first time the policy and the measured evidence agree.
 */
export const momentumScalp1mStopPolicy: ProtectiveStopPolicy = Object.freeze({
  breakEvenTriggerR: null,
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

  // `paper_trades_check` requires a LONG's stop strictly below entry; entry itself, or anything at
  // or above it, is a value this schema cannot persist. See the file docstring for what this floor
  // actually cost in production before it existed.
  const belowEntryCeiling = entryPrice - OPTION_TICK_SIZE;

  let candidate: number | null = null;
  let reason = "";
  if (policy.trail !== null && progressR >= policy.trail.triggerR) {
    candidate = Math.min(markPremium - policy.trail.distanceR * risk, belowEntryCeiling);
    reason = `trailed ${policy.trail.distanceR}R below the mark at +${progressR.toFixed(2)}R`;
  } else if (policy.breakEvenTriggerR !== null && progressR >= policy.breakEvenTriggerR) {
    candidate = belowEntryCeiling;
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
