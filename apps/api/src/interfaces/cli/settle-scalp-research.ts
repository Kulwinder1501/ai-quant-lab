import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchQueryRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-query-repository.js";
import { PostgresScalpResearchRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-repository.js";
import { SettleScalpResearchSubjects } from "../../modules/research/scalp-harness/application/settle-research-subjects.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer.");
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asOf = new Date(getOption(args, "as-of") ?? Date.now());
  if (Number.isNaN(asOf.getTime())) throw new Error("--as-of must be an ISO-8601 timestamp.");
  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));
  try {
    const result = await new SettleScalpResearchSubjects(
      new PostgresScalpResearchQueryRepository(database),
      new PostgresScalpResearchRepository(database),
    ).execute({ asOf, limit: positiveInteger(getOption(args, "limit"), 500) });
    console.info(JSON.stringify({ level: "info", message: "Scalp shadow settlement sweep completed", asOf, ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
