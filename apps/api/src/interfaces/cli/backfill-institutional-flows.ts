import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstitutionalFlowRepository } from "../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import { HistoricalFiiDiiArchiveClient } from "../../infrastructure/external/historical-fii-dii-archive-client.js";
import { BackfillInstitutionalFlows } from "../../modules/market-data/application/backfill-institutional-flows.js";
import { parseDateOption, requireOption } from "./arguments.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const from = parseDateOption(requireOption(args, "from"), false);
  const to = parseDateOption(requireOption(args, "to"), false);
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const result = await new BackfillInstitutionalFlows(
      new HistoricalFiiDiiArchiveClient(),
      new PostgresInstitutionalFlowRepository(database),
    ).execute({ from, to });
    console.info(JSON.stringify({ level: "info", message: "Institutional flow backfill complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
