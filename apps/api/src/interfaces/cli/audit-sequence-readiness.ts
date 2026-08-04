import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresSequenceReadinessRepository } from "../../infrastructure/database/repositories/postgres-sequence-readiness-repository.js";
import { AuditSequenceReadiness } from "../../modules/market-data/application/audit-sequence-readiness.js";

/**
 * Phase 25 Workstream D/E: TCN sequence-readiness gate.
 *
 * Reads the latest Workstream A data-readiness report, evaluates the bar-count /
 * session / volume / provider / semantics gates for each candidate, and
 * persists a hashed report. Stage 5 may open research only for candidates with
 * verdict PASS.
 *
 * Exit code 0 when the audit itself ran. A FAIL/BLOCKED candidate is a finding,
 * not an audit failure — inspect `anyResearchAuthorized` for whether any gate
 * cleared.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new AuditSequenceReadiness(
      new PostgresSequenceReadinessRepository(database),
    ).execute();

    if (process.argv.includes("--json")) {
      console.info(JSON.stringify(result.report));
      return;
    }

    for (const candidate of result.report.candidates) {
      const m = candidate.measurements;
      const label = `${m.symbol} ${m.timeframe} (${candidate.measurements.candidate})`.padEnd(28);
      console.info(
        `${candidate.verdict.padEnd(8)} ${label}`
        + ` bars=${m.barCount} sessions=${m.sessionCount}`
        + ` zeroVol=${(m.zeroVolumeFraction * 100).toFixed(2)}%`
        + ` semantics=${m.instrumentSemantics}`
        + ` series=${m.seriesState ?? "UNMEASURED"}`,
      );
      for (const finding of candidate.findings) {
        console.info(`         - [${finding.code}] ${finding.detail}`);
      }
    }
    console.info(JSON.stringify({
      level: "info",
      message: "Sequence-readiness audit persisted",
      reportId: result.reportId,
      reportHash: result.reportHash,
      createdAt: result.createdAt,
      summary: result.report.summary,
      anyResearchAuthorized: result.report.anyResearchAuthorized,
      contract: result.report.contract,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
