import type { DatabaseQueryable } from "../../infrastructure/database/database.js";

/**
 * Whether `audit-gold-shadow-failures.ts` (the G2 frozen-snapshot replay audit) has a real data
 * source to run against.
 *
 * Split out of the CLI script itself so this check -- and the refusal message below -- can be unit
 * tested without executing the script's top-level DB connection and `process.exit` calls, the same
 * reason `shadow-decision-options.ts` exists as its own module for `run-shadow-decisions.ts`.
 *
 * ## Why this exists at all
 *
 * The G2 tool was written against two things that were never built: 22 frozen case fixtures
 * (`gold-shadow-g2-001.json` .. `022.json`, absent from the repo and from git history) and a
 * `shadow_decisions` database table (`select to_regclass('public.shadow_decisions')` returns NULL
 * on the live database, `ai-quant-lab-db-v2` port 5433 -- confirmed 2026-10-05).
 *
 * The tool used to query `shadow_decisions` anyway, catch the resulting error, and print
 * "No shadow decisions found" before exiting 0 -- which reads exactly like a real audit that ran
 * cleanly and genuinely found nothing. It is not that: it is a tool with no data source at all, and
 * conflating the two hides a capability that was never built behind a result that looks like a
 * clean bill of health.
 *
 * ## The considered alternative, and why it was rejected
 *
 * `decision_ledger` / `differential_observations` (Brain V2.2's P5-P10 shadow-decision pipeline,
 * written by `run-shadow-decisions.ts`) is the only real "shadow decision" persistence this codebase
 * has. It does not serve G2's purpose: it is NSE-only (NIFTY50/BANKNIFTY, never gold), has no
 * `strategy_key = 'ict-structure'` or `AutoBot-Gold` concept, and carries none of the fields this
 * audit's failure taxonomy depends on (`protectedStatusAtCutoff`, `swingHierarchyPresent`,
 * `sessionDateMismatch`, `staleMacroTarget` -- all live only inside `ict-structure-strategy.ts`'s
 * in-memory `evaluate()` call, never persisted anywhere). Pointing G2 at it would not answer the
 * question G2 asks; it would silently substitute a different, unrelated comparison.
 */
export async function shadowDecisionsTableExists(database: DatabaseQueryable): Promise<boolean> {
  const result = await database.query<{ reg: string | null }>(
    "SELECT to_regclass('public.shadow_decisions') AS reg"
  );
  return result.rows[0]?.reg != null;
}

/**
 * The refusal this tool prints (to stderr) and exits non-zero on, instead of a silent
 * "No shadow decisions found" / exit 0.
 */
export const G2_NOT_FUNCTIONAL_MESSAGE = [
  "G2 audit refused: this tool is NOT YET FUNCTIONAL.",
  "",
  "`shadow_decisions` does not exist on this database (checked via",
  "`select to_regclass('public.shadow_decisions')`, which returned NULL).",
  "The 22 frozen case fixtures this tool is documented to replay",
  "(gold-shadow-g2-001.json .. gold-shadow-g2-022.json) also do not exist anywhere in this",
  "repository or its git history.",
  "",
  "Nothing was computed. Printing \"No shadow decisions found\" and exiting 0 here would be",
  "indistinguishable from a real, clean G2 audit that genuinely found nothing -- which is why this",
  "refuses instead of reporting a zero-row result.",
  "",
  "To make this tool real, either:",
  "  (a) build the `shadow_decisions` persistence path and the 22 case fixtures the original G2",
  "      spec calls for, or",
  "  (b) point it at a genuinely equivalent data source. As of 2026-10-05 none exists:",
  "      `decision_ledger` / `differential_observations` (Brain V2.2's shadow-decision pipeline,",
  "      `run-shadow-decisions.ts`) is NSE-only and carries none of the ict-structure gold fields",
  "      (protectedStatusAtCutoff, swingHierarchyPresent, sessionDateMismatch, staleMacroTarget)",
  "      this audit's failure taxonomy depends on.",
].join("\n");
