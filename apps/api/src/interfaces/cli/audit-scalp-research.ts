import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchAcceptanceRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-acceptance-repository.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

function dateOption(args: string[], name: string, fallback: Date): Date {
  const value = new Date(getOption(args, name) ?? fallback);
  if (Number.isNaN(value.getTime())) throw new Error(`--${name} must be an ISO-8601 timestamp.`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const through = dateOption(args, "through", new Date());
  const from = dateOption(args, "from", new Date(through.getTime() - 7 * 24 * 60 * 60 * 1_000));
  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));
  try {
    const report = await new PostgresScalpResearchAcceptanceRepository(database).generate({ from, through });
    console.info(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 2;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
