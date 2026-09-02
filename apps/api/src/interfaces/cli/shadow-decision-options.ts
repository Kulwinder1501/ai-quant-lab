import { getOption } from "./arguments.js";

/**
 * The shadow pass's flag parsing, in a module that does not run on import.
 *
 * Separated from `run-shadow-decisions.ts` for the reason `eod-training-plan.ts` is separate from the
 * pipeline that calls it: that CLI executes `main()` at top level, so importing it from a test starts
 * a real run, fails env validation and calls `process.exit(1)`. Logic worth testing has to live where
 * it can be imported.
 */

export type ProducerChoice = "native" | "ported-v1";

/**
 * Which producer V2.2 decides with this pass.
 *
 * Defaults to native, so nothing changes unless the flag is passed. `--producer=ported-v1` runs V1's
 * entry rule through V2.2's port for the platform-equivalence comparison, and is legal only because
 * the shadow path holds no execution port -- `assertMayHoldAuthority` refuses it anywhere that does.
 *
 * A flag rather than a default because the two answer different questions. Native measures what V2.2
 * decides on its own evidence, which is "nothing" today; ported measures whether the platform
 * reproduces V1's decisions, which is what P13 grades. Silently defaulting to ported would erase the
 * abstention record from the run that established it.
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
  if (raw === undefined || raw === "" || raw === "native") return "native";
  if (raw === "ported-v1") return "ported-v1";
  throw new Error(`Unknown --producer "${raw}". Use "native" or "ported-v1".`);
}
