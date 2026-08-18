/**
 * Why opening a paper trade failed, and whether that is an ordinary outcome or a fault.
 *
 * These live in the domain rather than beside the SQL because the distinction they encode is a
 * policy, not a database detail: it decides whether a bot cycle keeps going. It was previously
 * absent altogether, and the cost was concrete -- an uncaught throw from `openFromTradeIdea` aborted
 * the paper trading bot's whole run, skipping the rest of that bot's ideas, every remaining bot, and
 * each account's open-position evaluation.
 *
 * The most common trigger was the most benign one available: two bot accounts scan the same series,
 * and the first to open flips the idea to `ACCEPTED`, so the second cannot. That is contention.
 * Measured on the live scheduler, it failed 27% of runs on 2026-08-18 and 9% on 2026-08-17, against
 * 0% for the weeks before the two bots were given a strategy in common.
 */

/** The idea expired between being raised and being acted on. */
export class TradeIdeaExpiredError extends Error {}

/**
 * The idea is gone, or has expired or been rejected, so no account can open from it.
 *
 * Named so callers do not have to match on message text. Since 2026-08-18 this no longer fires merely
 * because another account got there first: `ACCEPTED` is admitted at the gate, so both bots can act
 * on a shared signal. What remains is a genuinely unusable idea.
 */
export class TradeIdeaUnavailableError extends Error {}

/**
 * This account already holds a position opened from this idea.
 *
 * The ordinary case, not a fault: the bot re-evaluates the same completed bar on every cycle and the
 * generator hands back the same idea row, so an account that traded a signal will be offered it again
 * until the bar rolls. One position per idea per account is the rule
 * `paper_trades_one_per_idea_per_account_idx` has always encoded; this reports reaching it as a
 * repeat rather than letting it surface as a unique-constraint violation.
 */
export class TradeIdeaAlreadyTakenError extends Error {}

/**
 * The account has already opened its permitted number of trades for this IST trading day.
 *
 * Distinct so a caller can treat it as a skip rather than a failure: a bot hitting its cap is the
 * control working, not an error to alert on, and a bare `Error` would read the same as a broken fill.
 */
export class DailyTradeCapReachedError extends Error {}

export interface OpenFailureClassification {
  readonly reason: string;
  readonly explanation: string;
  /**
   * True when the caller should record a refusal and carry on; false when the run should end up
   * marked failed.
   *
   * An unexpected failure is still worth recording as a refusal so the cycle's report is complete,
   * but it must not be *only* that. A broken database quietly filed under "signals refused" reads as
   * "the market offered nothing", which is the failure mode this codebase has hit repeatedly.
   */
  readonly expected: boolean;
}

export function classifyOpenFailure(error: unknown): OpenFailureClassification {
  if (error instanceof TradeIdeaUnavailableError) {
    return {
      reason: "TRADE_IDEA_UNAVAILABLE",
      explanation: "Another account opened from this idea first, so it is no longer PROPOSED. "
        + "Expected while two bots share a strategy; it is contention, not a fault.",
      expected: true,
    };
  }
  if (error instanceof TradeIdeaAlreadyTakenError) {
    return { reason: "TRADE_IDEA_ALREADY_TAKEN", explanation: error.message, expected: true };
  }
  if (error instanceof TradeIdeaExpiredError) {
    return {
      reason: "TRADE_IDEA_EXPIRED",
      explanation: "The idea expired between being raised and being acted on.",
      expected: true,
    };
  }
  if (error instanceof DailyTradeCapReachedError) {
    // The cap firing is the control working. Left uncontained this would have crashed the run the
    // first time any account was actually given a cap -- none has one yet, so it had never fired.
    return { reason: "DAILY_TRADE_CAP_REACHED", explanation: error.message, expected: true };
  }
  return {
    reason: "OPEN_FAILED",
    explanation: error instanceof Error ? error.message : String(error),
    expected: false,
  };
}
