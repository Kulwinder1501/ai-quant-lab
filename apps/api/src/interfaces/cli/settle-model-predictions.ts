import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresModelPredictionSettlementRepository } from "../../infrastructure/database/repositories/postgres-model-prediction-settlement-repository.js";
import { SettleModelPredictions } from "../../modules/model-predictions/application/settle-model-predictions.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new SettleModelPredictions(
      new PostgresModelPredictionSettlementRepository(database),
    ).execute();
    console.info(JSON.stringify({ level: "info", message: "Model prediction settlement complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
