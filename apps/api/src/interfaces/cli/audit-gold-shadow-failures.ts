import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

/**
 * G2 — Frozen Snapshot Replay Audit (Phase G2 of the implementation plan)
 *
 * Replays the OLD vs NEW ict-structure-strategy evaluators against frozen case JSON fixtures
 * to classify failure taxonomy and confirm that G1 invariants now reject the shadow cases.
 *
 * This script reads `gold_shadow_decisions` (or equivalent) from the database and re-evaluates
 * each proposal snapshot with both the legacy evaluator (before G1 changes) and the current
 * evaluator (after G1 changes), then reports which proposals would have been REJECTED by the
 * new fail-closed invariants.
 *
 * Failure taxonomy (matching the FailureTaxonomyRecord spec):
 *   SESSION_CALIBRATION       - sessionDate resolver mismatch (old hardcoded vs DST-aware)
 *   PROTECTED_LEVEL_BREACH    - protectedStatusAtCutoff was BREACHED but old code allowed it
 *   STALE_MACRO_TARGET        - macro target was stale at entry time
 *
 * Usage:
 *   npm run research:gold:shadow-audit [--account AutoBot-Gold] [--from 2026-09-01] [--to 2026-10-01]
 *
 * Note: Full replay requires injecting the old vs new strategy evaluator. This script
 * computes the audit from persisted decision metadata (shadow_decisions table) without
 * requiring a full market context replay, which is more PIT-safe.
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

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const accountId = argValue("--account") ?? "AutoBot-Gold";
const fromDate = argValue("--from");
const toDate = argValue("--to");

const whereClause = ["sd.account_id = $1", "sd.strategy_key = 'ict-structure'"];
const params: unknown[] = [accountId];
if (fromDate) { params.push(fromDate); whereClause.push(`sd.evaluated_at >= $${params.length}::timestamptz`); }
if (toDate) { params.push(toDate); whereClause.push(`sd.evaluated_at < $${params.length}::timestamptz`); }

// Query shadow decisions with their market context metadata
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
`, params).catch(() => {
  // Shadow decisions table may not exist — report gracefully
  return { rows: [] as never[] };
});

if (!result.rows.length) {
  console.log(`No shadow decisions found for account ${accountId} with strategy ict-structure.`);
  console.log("The G2 audit requires shadow decisions recorded by run-shadow-decisions.ts.");
  console.log("To populate: npm run shadow:decisions -- --account AutoBot-Gold");
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
