import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresSessionOutcomeRepository } from "../../infrastructure/database/repositories/postgres-premarket-repository.js";
import { SettleSessionOutcomes } from "../../modules/premarket-intelligence/application/settle-session-outcomes.js";

/** Measures the gap / first-hour / full-session outcomes the stored pre-market snapshots are scored against. */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new SettleSessionOutcomes(new PostgresSessionOutcomeRepository(database)).execute();
    console.info(JSON.stringify({ level: "info", message: "Session outcome settlement complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
