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
