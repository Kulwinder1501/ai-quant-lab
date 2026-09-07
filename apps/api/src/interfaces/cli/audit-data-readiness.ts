import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresDataReadinessRepository } from "../../infrastructure/database/repositories/postgres-data-readiness-repository.js";
import { AuditDataReadiness } from "../../modules/market-data/application/audit-data-readiness.js";

/**
 * Phase 25 Workstream A: the data-readiness audit.
 *
 * Measures every stored candle series, assigns READY / DEGRADED / STALE /
 * INVALID, and persists the machine-readable report with a content hash.
 * `train.py` reads the latest persisted report and refuses to fit a series
 * that is not READY, recording the report id and hash in the artifact's
 * validation protocol — so every research run can prove the data health it
 * ran under.
 *
 * Prints a per-series summary; pass `--json` to dump the full report instead.
 * Always exits 0 when the audit itself ran: a DEGRADED series is a finding,
 * not a failure of the audit.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new AuditDataReadiness(
      new PostgresDataReadinessRepository(database),
    ).execute();

    if (process.argv.includes("--json")) {
      console.info(JSON.stringify(result.report));
      return;
    }

    for (const entry of result.report.series) {
      const label = `${entry.symbol} ${entry.timeframe}`.padEnd(18);
      const line = `${entry.state.padEnd(8)} ${label} bars=${entry.barCount} sessions=${entry.sessionCount}`
        + ` age=${entry.ageWeekdays}wd zeroVol=${(entry.zeroVolumeFraction * 100).toFixed(0)}%`;
      console.info(line);
      for (const reason of entry.reasons) {
        console.info(`         - ${reason}`);
      }
    }
    console.info(JSON.stringify({
      level: "info",
      message: "Data-readiness audit persisted",
      reportId: result.reportId,
      reportHash: result.reportHash,
      createdAt: result.createdAt,
      summary: result.report.summary,
      instrumentsWithoutBars: result.report.instrumentsWithoutBars,
      institutionalFlows: result.report.context.institutionalFlows,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
