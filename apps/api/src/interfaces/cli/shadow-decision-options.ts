import { getOption } from "./arguments.js";

/**
 * The shadow pass's flag parsing, in a module that does not run on import.
 *
 * Separated from `run-shadow-decisions.ts` for the reason `eod-training-plan.ts` is separate from the
 * pipeline that calls it: that CLI executes `main()` at top level, so importing it from a test starts
 * a real run, fails env validation and calls `process.exit(1)`. Logic worth testing has to live where
 * it can be imported.
 */

export type ProducerChoice = "native" | "ported-v1" | "both";

/**
 * Which producer V2.2 decides with this pass.
 *
 * **Defaults to `both`**, because the two answer different questions and P13 needs both answers.
 * Native measures what V2.2 decides on its own evidence, which is "nothing" today; ported measures
 * whether the platform reproduces V1's decisions. Neither substitutes for the other, and running one
 * would leave the other's population empty -- which is how the ported producer sat unused for a day
 * while the scheduler ran native only.
 *
 * Running both is safe because the shadow path holds no execution port at all. The ported producer can
 * approve, and `assertMayHoldAuthority` refuses it anywhere that could act on the approval.
 *
 * Each producer's observations are keyed and graded separately (migration 094), so two producers on
 * one bar are two records rather than a collision.
 *
 * ## Parsed wrong twice on the first attempt
 *
 * `getOption` prepends the dashes itself, so `"--producer"` looked for `----producer` and could never
 * match; and the absent case was compared against `null` when the helper returns `undefined`. Together
 * they made *every* run fail with `Unknown --producer "undefined"` -- including the default path that
 * passes no flag at all. A live pass against production is what surfaced it, which is why the parse is
 * now a tested unit rather than something exercised only end to end.
 */
export function producerChoice(args: readonly string[]): ProducerChoice {
  const raw = getOption([...args], "producer")?.trim();
  if (raw === undefined || raw === "" || raw === "both") return "both";
  if (raw === "native") return "native";
  if (raw === "ported-v1") return "ported-v1";
  throw new Error(`Unknown --producer "${raw}". Use "native", "ported-v1" or "both".`);
}

/**
 * How long after a bar closes it may still be decided, beyond the bar's own length.
 *
 * A fixed three-minute ceiling was correct while the pass only read 1m bars, and wrong the moment it
 * read 5m ones: a 5m bar is up to five minutes old before its successor exists, so a flat three
 * minutes would have refused most 5m bars as stale and the wider coverage would have quietly produced
 * nothing. The ceiling has to scale with the bar.
 *
 * Two minutes of grace on top of one bar period, which reproduces the previous 1m behaviour exactly
 * (60s + 120s = the old 3 minutes) and gives 5m a 7-minute window against a 5-minute cron.
 */
export const BAR_AGE_GRACE_MS = 2 * 60_000;

/**
 * The timeframes V2.2 decides on, and why exactly these two.
 *
 * Measured from V1's own output over 21 days, by the timeframe of the bar each proposal was drawn
 * from:
 *
 * | timeframe | proposals | strategies |
 * | :--- | ---: | :--- |
 * | 5m | 948 | momentum-scalp-index, momentum-scalp-pattern, momentum-scalp-pattern-v2 |
 * | 1m | 179 | momentum-scalp |
 *
 * The pass read only 1m until 2026-09-02, which left 85% of V1's live decisions outside the
 * comparison -- including `momentum-scalp-index`, which is 5m-only, is the largest single decision
 * source, and is the largest loser at -Rs 32,911 over 288 trades. `strategySupportsTimeframe` filtered
 * it out of every bar the pass looked at, so P13 could never have graded the part of V1 that matters.
 *
 * Intraday is deliberately absent. `trend-breakout` owns 15m/30m/60m/1d and last proposed on
 * 2026-08-24 -- 7 proposals in 21 days, none in the last 7. Adding those timeframes would add bars and
 * no decisions, inflating `comparisons` with rows that cannot be decisive; P13's coverage floor would
 * refuse them anyway. When that strategy proposes again, `--timeframes` covers it without a change
 * here.
 */
export const SHADOW_TIMEFRAMES: readonly string[] = ["1m", "5m"];

/** Bar length in milliseconds. Throws rather than guessing: a wrong interval mis-reads the tape. */
export function timeframeMs(timeframe: string): number {
  const match = /^(\d+)(m|h)$/.exec(timeframe);
  if (!match) throw new Error(`Unsupported shadow timeframe "${timeframe}". Use minutes or hours.`);
  return Number(match[1]) * (match[2] === "m" ? 60_000 : 3_600_000);
}


/** The ceiling for one timeframe: the operator's override if given, otherwise one bar plus grace. */
export function barAgeCeilingFor(timeframe: string, override: number | null): number {
  return override ?? timeframeMs(timeframe) + BAR_AGE_GRACE_MS;
}
