import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { RunGate7Acceptance } from "../../modules/stock-intelligence/application/run-gate7-acceptance.js";
import { getOption, parseDateOption, requireOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const jobId = requireOption(argumentsList, "job-id");
  const asOfRaw = getOption(argumentsList, "as-of");
  const evaluationAsOf = asOfRaw
    ? parseDateOption(asOfRaw, true)
    : new Date();

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const store = new PostgresStockIntelligenceStore(database);
    const report = await new RunGate7Acceptance(store).execute({
      jobId,
      evaluationAsOf,
    });
    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence Gate 7 formal acceptance",
      method: "gate7_formal_acceptance",
      jobId,
      passed: report.passed,
      enablementEligible: report.enablement.eligible,
      enablementReason: report.enablement.reason,
      report,
    }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
