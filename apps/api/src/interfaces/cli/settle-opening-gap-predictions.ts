import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresOpeningGapPredictionRepository } from "../../infrastructure/database/repositories/postgres-opening-gap-prediction-repository.js";
import { SettleOpeningGapPredictions } from "../../modules/market-data/application/settle-opening-gap-predictions.js";

/** Grades matured opening-gap predictions against the real 09:15 IST open. Idempotent. */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new SettleOpeningGapPredictions(
      new PostgresOpeningGapPredictionRepository(database),
    ).execute();
    console.info(JSON.stringify({ level: "info", message: "Opening gap settlement complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
