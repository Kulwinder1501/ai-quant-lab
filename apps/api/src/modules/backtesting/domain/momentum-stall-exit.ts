/**
 * Backtest-only measurement of the live `MOMENTUM_STALL` rule
 * (`paper-trading/application/evaluate-open-paper-trades.ts`, `MOMENTUM_STALL_POLICIES` and the
 * clause that reads it), re-derived for underlying-index price bars instead of option premium bids.
 *
 * The live rule exists because a scalp (Reward/Risk <= 1.6) that has not made meaningful progress
 * toward target after a fixed amount of market time is more likely to be going nowhere than to be a
 * slow winner, and holding it ties up the one open slot and keeps eating theta/fees while it decides.
 * Directional setups (target ~2R+) are deliberately exempt: they are given more room to breathe and
 * form the trend, per the live evaluator's own comment.
 *
 * This version is side-aware and works in underlying-index points directly, the same "this project's
 * existing backtest cohort already answers the strategy-level question" posture
 * `underlying-protective-stop.ts` documents for the break-even/trail mechanism -- there is no reason
 * to build a second, options-tick-accurate harness to re-ask a question about R-multiple progress
 * over elapsed time, when the underlying-price cohort already answers it for every other lever this
 * project has measured.
 */
export interface MomentumStallPolicy {
  readonly cutoffMinutes: number;
  readonly minimumProgressR: number;
}

export interface MomentumStallCheckInput {
  readonly side: "LONG" | "SHORT";
  readonly entryPrice: number;
  /** The OPENING stop, before any break-even/trail advance -- see below for why. */
  readonly initialStopLoss: number;
  readonly targetPrice: number;
  readonly openedAt: Date;
  /** The current bar's close time. */
  readonly asOf: Date;
  /** The current bar's close. */
  readonly currentPrice: number;
  readonly policy: MomentumStallPolicy;
}

/**
 * True when the live evaluator's `MOMENTUM_STALL` rule would close this position right now.
 *
 * Uses the OPENING stop, not whatever stop is currently in force, for the same reason the live
 * evaluator does: reading the live (possibly break-even-advanced) stop collapses risk toward zero
 * once a trade has moved to +0.5R, which pushes `reward / risk` past the `<= 1.6` scalp test and
 * switches this rule off for exactly the trades that touched +0.5R progress and then died -- the
 * same failure mode that withdrew the V4 stall variant, arriving through the stop instead of the
 * target. Using the opening geometry keeps the scalp/directional classification fixed at entry,
 * where it belongs.
 *
 * The LONG progress condition below (`currentPrice >= entryPrice + minimumProgressR * initialRisk`
 * counts as "not stalled") mirrors the live evaluator's own form, which reads
 * `freshBid < trade.entryPrice + stallPolicy.minimumProgressR * initialRisk` as the stalled case for
 * LONG. The live evaluator only ever handles this one direction explicitly, because every option
 * BUY (call or put) is structured as LONG in premium space -- there is no live SHORT case to mirror.
 * The SHORT case here is derived from first principles, not copied from a live branch: a SHORT
 * profits as price falls, so its progress condition is the mirror image, requiring
 * `currentPrice <= entryPrice - minimumProgressR * initialRisk` to count as progress made.
 */
export function isMomentumStalled(input: MomentumStallCheckInput): boolean {
  const { side, entryPrice, initialStopLoss, targetPrice, openedAt, asOf, currentPrice, policy } = input;

  const initialRisk = side === "LONG" ? entryPrice - initialStopLoss : initialStopLoss - entryPrice;
  if (!(initialRisk > 0)) return false;

  const initialReward = side === "LONG" ? targetPrice - entryPrice : entryPrice - targetPrice;
  const isScalp = initialReward / initialRisk <= 1.6;
  if (!isScalp) return false;

  const elapsedMinutes = (asOf.getTime() - openedAt.getTime()) / 60_000;
  if (elapsedMinutes < policy.cutoffMinutes) return false;

  const progressMade = side === "LONG"
    ? currentPrice >= entryPrice + policy.minimumProgressR * initialRisk
    : currentPrice <= entryPrice - policy.minimumProgressR * initialRisk;

  return !progressMade;
}
