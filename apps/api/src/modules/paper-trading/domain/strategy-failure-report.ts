/**
 * Strategy evaluations that threw, as opposed to ones that found nothing to propose.
 *
 * `GenerateTradeIdeas` catches a strategy's exception so one broken strategy cannot cost the others their ideas, and records it as
 * `skippedReason: "STRATEGY_FAILED"`. That is the right isolation and a poor alarm: the bot printed it inside a long JSON report that
 * nothing kept, the run still completed, and from outside it looked exactly like a quiet day. From 2026-10-13 to 2026-11-02 the ICT
 * strategy threw on every real setup (a cached snapshot's timestamps were strings) and nothing anywhere said so.
 *
 * A refusal ("rules not met", "duplicate idea", a contended slot) is the system working. An exception is a fault, so the bot raises it
 * once the cycle has finished its work, the same way it raises `unexpectedOpenFailures`. The run is then recorded FAILED in
 * `scheduled_job_runs` with this text as the reason, where it can be queried.
 */
export interface StrategyFailure {
  readonly bot: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly strategy: string;
  readonly message: string | null;
}

const MAX_MESSAGE_CHARS = 240;
const MAX_LISTED = 5;

function clip(message: string): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length <= MAX_MESSAGE_CHARS ? single : `${single.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * One sentence for the run's failure reason, or null when nothing threw.
 *
 * The same failure on the same series reported by two bots is one problem, so it is listed once with every bot that saw it. The
 * list is capped, because the stored reason keeps only the tail of the output and a long list would push the cause out of it.
 */
export function describeStrategyFailures(failures: readonly StrategyFailure[]): string | null {
  if (failures.length === 0) return null;

  const groups = new Map<string, { failure: StrategyFailure; bots: Set<string> }>();
  for (const failure of failures) {
    const key = [failure.strategy, failure.symbol, failure.timeframe, failure.message ?? ""].join("|");
    const existing = groups.get(key);
    if (existing) existing.bots.add(failure.bot);
    else groups.set(key, { failure, bots: new Set([failure.bot]) });
  }

  const listed = [...groups.values()].slice(0, MAX_LISTED).map(({ failure, bots }) =>
    `${failure.strategy} on ${failure.symbol} ${failure.timeframe} threw "${failure.message === null ? "no message" : clip(failure.message)}" (${[...bots].join(", ")})`);
  const hidden = groups.size - listed.length;

  return `${groups.size} strategy evaluation(s) threw, so the bar was read but no idea could be raised: `
    + `${listed.join("; ")}${hidden > 0 ? `; and ${hidden} more` : ""}. `
    + "Every other bot and the open-position evaluation still ran; see strategyFailures.";
}
