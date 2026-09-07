import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresModelCompetitionRepository } from "../../infrastructure/database/repositories/postgres-model-competition-repository.js";
import { RunModelCompetition } from "../../modules/model-predictions/application/run-model-competition.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new RunModelCompetition(
      new PostgresModelCompetitionRepository(database),
    ).execute();
    console.info(JSON.stringify({ level: "info", message: "Daily model competition complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
