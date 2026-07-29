import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "./database.js";
import { migrations } from "./migrations/index.js";
import { runMigrations } from "./migration-runner.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const result = await runMigrations(database, migrations);
    console.info(JSON.stringify({ level: "info", message: "Database migrations finished", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
