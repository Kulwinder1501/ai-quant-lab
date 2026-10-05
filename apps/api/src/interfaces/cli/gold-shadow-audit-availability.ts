import type { DatabaseQueryable } from "../../infrastructure/database/database.js";

/**
 * Whether `audit-gold-shadow-failures.ts` (the G2 shadow-decision failure-taxonomy audit) has a
 * real data source to run against.
 *
 * Split out of the CLI script itself so this check -- and the refusal message below -- can be unit
 * tested without executing the script's top-level DB connection and `process.exit` calls, the same
 * reason `shadow-decision-options.ts` exists as its own module for `run-shadow-decisions.ts`.
 *
 * ## History: why this existed as a refusal, and what changed
 *
 * As of 2026-10-05 this guard refused unconditionally: `shadow_decisions` had never been migrated
 * (`select to_regclass('public.shadow_decisions')` returned NULL on `ai-quant-lab-db-v2` port 5433),
 * and the tool used to query it anyway, catch the resulting error, and print "No shadow decisions
 * found" before exiting 0 -- which reads exactly like a real audit that ran cleanly and genuinely
 * found nothing. It is not that: it was a tool with no data source at all, and conflating the two
 * hid a capability that was never built behind a result that looks like a clean bill of health.
 *
 * Migration 123 now defines `shadow_decisions`, and `generate-trade-ideas.ts` +
 * `run-gold-paper-trading-bot.ts` write a row to it on every `ict-structure-v1` evaluation (see
 * `ict-shadow-diagnostics.ts` for the taxonomy fields a row carries). This guard stays in place
 * rather than being deleted: it still correctly refuses on any database the migration has not yet
 * been run against, which is exactly the same honest-failure posture, just against a real migration
 * instead of a permanently-missing one.
 *
 * ## The considered alternative, and why it was rejected
 *
 * `decision_ledger` / `differential_observations` (Brain V2.2's P5-P10 shadow-decision pipeline,
 * written by `run-shadow-decisions.ts`) is NSE-only (NIFTY50/BANKNIFTY, never gold), has no
 * `strategy_key = 'ict-structure-v1'` or `AutoBot-Gold` concept, and carries none of the fields
 * this audit's failure taxonomy depends on. Pointing G2 at it would not have answered the question
 * G2 asks; it would have silently substituted a different, unrelated comparison. `shadow_decisions`
 * is its own table for exactly this reason.
 *
 * ## What is still not built
 *
 * The original G2 design's second half -- replaying an OLD vs. a NEW strategy evaluator against 22
 * frozen case fixtures (`gold-shadow-g2-001.json` .. `022.json`) -- remains unbuilt; no such
 * fixtures exist anywhere in this repo or its history. `audit-gold-shadow-failures.ts` answers a
 * narrower question instead: what did the taxonomy flags the live engine actually computed, at
 * decision time, say about each persisted decision. See that script's own header comment.
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
 *
 * Still named `G2_NOT_FUNCTIONAL_MESSAGE` even though `shadow_decisions` is now a real, migrated
 * table (123) on a database that has run it -- the name describes what THIS refusal means (G2 has
 * no data source to read, on whichever database the caller just pointed it at), not a permanent
 * property of the tool. Renaming it is unnecessary churn for every existing import.
 */
export const G2_NOT_FUNCTIONAL_MESSAGE = [
  "G2 audit refused: no data source on this database.",
  "",
  "`shadow_decisions` does not exist on this database (checked via",
  "`select to_regclass('public.shadow_decisions')`, which returned NULL).",
  "",
  "That table is defined by migration 123 and populated by run-gold-paper-trading-bot.ts on every",
  "ict-structure-v1 evaluation (see ict-shadow-diagnostics.ts). If this database has not run",
  "migration 123 yet, run migrations first, then run the gold bot at least once before re-running",
  "this audit.",
  "",
  "Printing \"No shadow decisions found\" and exiting 0 here would be indistinguishable from a real,",
  "clean G2 audit that genuinely found nothing -- which is why this refuses instead of reporting a",
  "zero-row result for a table that was never even queryable.",
  "",
  "Note: `decision_ledger` / `differential_observations` (Brain V2.2's shadow-decision pipeline,",
  "`run-shadow-decisions.ts`) is NOT a substitute even once that pipeline has data -- it is NSE-only",
  "and carries none of the ict-structure gold fields (protectedStatusAtCutoff, swingHierarchyPresent,",
  "sessionDateMismatch, staleMacroTarget) this audit's failure taxonomy depends on.",
].join("\n");
