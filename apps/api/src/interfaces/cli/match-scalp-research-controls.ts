import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchQueryRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-query-repository.js";
import { PostgresScalpResearchRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-repository.js";
import { MatchScalpResearchControls } from "../../modules/research/scalp-harness/application/match-research-controls.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asOf = new Date(getOption(args, "as-of") ?? Date.now());
  const limit = Number(getOption(args, "limit") ?? 500);
  if (Number.isNaN(asOf.getTime())) throw new Error("--as-of must be an ISO-8601 timestamp.");
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer.");
  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));
  try {
    const result = await new MatchScalpResearchControls(
      new PostgresScalpResearchQueryRepository(database),
      new PostgresScalpResearchRepository(database),
    ).execute({ asOf, limit });
    console.info(JSON.stringify({ level: "info", message: "Outcome-blind scalp control matching completed", asOf, ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
