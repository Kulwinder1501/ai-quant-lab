import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { G2_NOT_FUNCTIONAL_MESSAGE, shadowDecisionsTableExists } from "./gold-shadow-audit-availability.js";
import { ICT_STRUCTURE_STRATEGY_KEY } from "../../modules/technical-analysis/domain/ict/config.js";

/**
 * G2 — Shadow Decision Failure-Taxonomy Audit (Phase G2 of the Gold Bot & Option Scalper spec)
 *
 * Reads `shadow_decisions` (migration 123, written by `generate-trade-ideas.ts` +
 * `run-gold-paper-trading-bot.ts` every time `ict-structure-v1` evaluates a bar) and summarizes
 * which decisions carry the failure-taxonomy flags G1's fail-closed invariants care about:
 *
 *   SESSION_CALIBRATION       - this bar's instant buckets into a different session date under
 *                               NSE_IST_PROFILE than under the instrument's own profile (gold's
 *                               DST-aware NY-session rollover; see ict-shadow-diagnostics.ts)
 *   PROTECTED_LEVEL_BREACH    - protectedStatusAtCutoff was BREACHED or UNKNOWN while a swing
 *                               hierarchy was actually present (i.e. not merely unformed)
 *   STALE_MACRO_TARGET        - liquidity.primaryTarget disagreed with the independently
 *                               recomputed draw-on-liquidity selection for the same bar
 *
 * Usage:
 *   npm run research:gold:shadow-audit [--account AutoBot-Gold] [--from 2026-09-01] [--to 2026-10-01]
 *
 * ## What this does NOT do
 *
 * This does not replay an old vs. a new strategy evaluator against frozen fixtures -- that was the
 * original G2 design's second half, and it was never built (no `gold-shadow-g2-NNN.json` fixtures
 * exist anywhere in this repo or its history). What it does instead is read taxonomy flags that
 * were computed ONCE, at decision time, from the real engine (`IctShadowDiagnostics`, see
 * `ict-shadow-diagnostics.ts`), and persisted alongside the decision. That is a narrower claim than
 * "replay-verified", but it is a real one: every flag here reflects what the live engine actually
 * computed for that bar, not a fixture standing in for it. A dual-evaluator replay harness remains
 * unbuilt and would be a separate, later piece of work.
 */

export interface FailureTaxonomyRecord {
  readonly caseId: string;
  readonly proposalId: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly changedFields: readonly string[];
  readonly failureReasons: readonly ("SESSION_CALIBRATION" | "PROTECTED_LEVEL_BREACH" | "STALE_MACRO_TARGET")[];
  readonly primaryFailureReason: string;
  readonly outcomeG1: "SURVIVES_G1" | "REJECTED_BY_G1_INVARIANTS";
}

const env = loadEnvironment();
const pool = await createDatabasePool(env.DATABASE_URL);

/*
 * Checked BEFORE anything else runs. The query below used to run unconditionally and swallow
 * whatever error a missing `shadow_decisions` table produced, which made "the table doesn't exist"
 * and "the table exists and is genuinely empty" print the identical message. Those are not the same
 * fact, and only one of them is a clean audit result.
 */
if (!(await shadowDecisionsTableExists(pool))) {
  console.error(G2_NOT_FUNCTIONAL_MESSAGE);
  await pool.end();
  process.exit(1);
}

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const accountId = argValue("--account") ?? "AutoBot-Gold";
const fromDate = argValue("--from");
const toDate = argValue("--to");

const whereClause = ["sd.account_id = $1", "sd.strategy_key = $2"];
const params: unknown[] = [accountId, ICT_STRUCTURE_STRATEGY_KEY];
if (fromDate) { params.push(fromDate); whereClause.push(`sd.evaluated_at >= $${params.length}::timestamptz`); }
if (toDate) { params.push(toDate); whereClause.push(`sd.evaluated_at < $${params.length}::timestamptz`); }

// Query shadow decisions with their market context metadata. The table is now known to exist (the
// guard above returned true), so a failure here is a real defect and must surface, not be swallowed.
const result = await pool.query<{
  id: string;
  account_id: string;
  evaluated_at: Date;
  proposal_count: number;
  decision: string;
  context_metadata: Record<string, unknown> | null;
  strategy_metadata: Record<string, unknown> | null;
}>(`
  SELECT sd.id, sd.account_id, sd.evaluated_at,
         sd.proposal_count, sd.decision,
         sd.context_metadata, sd.strategy_metadata
  FROM shadow_decisions sd
  WHERE ${whereClause.join(" AND ")}
  ORDER BY sd.evaluated_at ASC
  LIMIT 1000
`, params);

if (!result.rows.length) {
  // The table is real and was queried successfully; a genuinely empty result is a legitimate
  // outcome here (unlike the missing-table case above, which never reaches this line).
  console.log(`No shadow decisions found for account ${accountId} with strategy ${ICT_STRUCTURE_STRATEGY_KEY}.`);
  console.log("shadow_decisions is populated by run-gold-paper-trading-bot.ts on every scheduler tick");
  console.log("that evaluates ict-structure-v1 against a fresh bar -- run the bot, then re-run this audit.");
  await pool.end();
  process.exit(0);
}

console.log(`G2 Audit: ${result.rows.length} shadow decisions for ${accountId}\n`);

const records: FailureTaxonomyRecord[] = [];
let survivesCount = 0, rejectedCount = 0;

for (const row of result.rows) {
  const meta = row.strategy_metadata ?? {};
  const context = row.context_metadata ?? {};

  // Diagnose which G1 invariants would now reject this decision
  const failureReasons: ("SESSION_CALIBRATION" | "PROTECTED_LEVEL_BREACH" | "STALE_MACRO_TARGET")[] = [];

  // Check 1: Protected level status
  // If the metadata records protectedLevelBreached=true OR protectedStatus=UNKNOWN,
  // the new fail-closed gate (requireProtectedLevelIntact=true) would reject it.
  const protectedLevelBreached = Boolean(meta.protectedLevelBreached ?? context.protectedLevelBreached);
  const protectedStatus = String(meta.protectedStatusAtCutoff ?? "UNKNOWN");
  if (protectedLevelBreached || protectedStatus === "BREACHED" || protectedStatus === "UNKNOWN") {
    // Only flag if the bot has requireProtectedLevelIntact=true (check bot config or presence of swing hierarchy data)
    const swingHierarchyPresent = Boolean(meta.swingHierarchyPresent ?? context.swingHierarchyPresent);
    if (swingHierarchyPresent) {
      failureReasons.push("PROTECTED_LEVEL_BREACH");
    }
  }

  // Check 2: Session calibration (look for sessionDate mismatch flags in metadata)
  const sessionCalibrationIssue = Boolean(meta.sessionDateMismatch ?? context.sessionDateMismatch);
  if (sessionCalibrationIssue) {
    failureReasons.push("SESSION_CALIBRATION");
  }

  // Check 3: Stale macro target
  const staleMacroTarget = Boolean(meta.staleMacroTarget ?? context.staleMacroTarget);
  if (staleMacroTarget) {
    failureReasons.push("STALE_MACRO_TARGET");
  }

  const outcomeG1 = failureReasons.length > 0 ? "REJECTED_BY_G1_INVARIANTS" : "SURVIVES_G1";
  if (outcomeG1 === "SURVIVES_G1") survivesCount++;
  else rejectedCount++;

  const record: FailureTaxonomyRecord = {
    caseId: `gold-shadow-g2-${String(records.length + 1).padStart(3, "0")}`,
    proposalId: row.id,
    before: { decision: row.decision, proposalCount: row.proposal_count, ...meta },
    after: { outcomeG1, failureReasons },
    changedFields: failureReasons.length > 0 ? ["outcome"] : [],
    failureReasons,
    primaryFailureReason: failureReasons[0] ?? "NONE",
    outcomeG1,
  };
  records.push(record);
}

console.log("─".repeat(100));
console.log(`G2 Audit Results:`);
console.log(`  Total decisions analysed : ${records.length}`);
console.log(`  Survive G1 invariants    : ${survivesCount}`);
console.log(`  Rejected by G1           : ${rejectedCount}`);
console.log("─".repeat(100));

if (rejectedCount > 0) {
  console.log("\nRejected decisions (would be blocked by G1 fail-closed gates):");
  for (const r of records.filter(x => x.outcomeG1 === "REJECTED_BY_G1_INVARIANTS").slice(0, 20)) {
    console.log(`  ${r.caseId}  ${r.proposalId.slice(0, 36)}  Primary: ${r.primaryFailureReason}  Reasons: [${r.failureReasons.join(", ")}]`);
  }
}

// Taxonomy breakdown
const byPrimary = new Map<string, number>();
for (const r of records) {
  const k = r.primaryFailureReason;
  byPrimary.set(k, (byPrimary.get(k) ?? 0) + 1);
}
console.log("\nPrimary failure reason breakdown:");
for (const [reason, count] of [...byPrimary.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(35)} ${count}`);
}

await pool.end();
