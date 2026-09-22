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
 * That floor used to apply to the trail branch too, and **that was the bug, not a defensive choice**.
 * A trailed stop clamped to one tick below entry is break-even with extra arithmetic: it can tighten
 * toward entry and never past it, so it cannot lock in a single rupee of profit. Migration 117 moved
 * the opening invariant onto `initial_stop_loss`, where it actually belongs, and `trail.lockProfit`
 * now selects whether the clamp applies. It defaults to false, so every config written before that
 * migration behaves exactly as it did.
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
 *
 * ## The trail result on record was a break-even result (2026-09-22)
 *
 * The paragraph above says the trail config "never once activated". That is true and it was not a
 * property of the data: with the entry-price clamp in force, a trail and a break-even are the same
 * stop. Replaying the stored premium ticks of all 439 closed option trades, `trail 0.5R/0.25R`
 * clamped and `break-even @0.5R` produce the identical book, +9,632.96 against the recorded
 * baseline, to the rupee. So nothing measured here had ever tested trailing.
 *
 * The profit-locking arm has now been measured, and it does **not** clear either -- best config
 * `trail 0.5R/0.5R lock` is +41.39/trade at t=2.33 against a Šidák threshold of ~3.10 over nine
 * configurations, it is carried almost entirely by BANKNIFTY (+66.59, t=3.14) with NIFTY50 at
 * +12.89 (t=0.47), and its top five winners are 51.5% of the whole effect. See
 * `docs/exit-geometry-falsification-program-v1.md`, Amendment 1, for the full gate readout. It ships
 * available and off, like everything else that did not clear.
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
    /**
     * Whether the trailed stop may sit **above** entry, locking in profit rather than merely
     * protecting against a loss. Omitted means false, which is the behaviour every existing config
     * had and keeps them byte-identical.
     *
     * Until migration 117 this could not be expressed at all: `paper_trades_check` required a LONG's
     * stop below entry, so the clamp below was not a policy choice but the only persistable value.
     * See that migration for the measurement showing what the clamp cost -- with it, a trail and a
     * plain break-even produce the same book to the rupee.
     */
    readonly lockProfit?: boolean;
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
    const trailed = markPremium - policy.trail.distanceR * risk;
    // The ceiling is what made a trail indistinguishable from break-even. `lockProfit` lifts it; the
    // `candidate >= markPremium` guard below still refuses a stop at or above the mark either way.
    candidate = policy.trail.lockProfit === true ? trailed : Math.min(trailed, belowEntryCeiling);
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
