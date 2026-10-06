import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresAuxiliaryPredictionSettlementRepository } from "../../infrastructure/database/repositories/postgres-auxiliary-prediction-settlement-repository.js";
import { SettleAuxiliaryPredictions } from "../../modules/model-predictions/application/settle-auxiliary-predictions.js";

/**
 * Settles matured non-directional predictions.
 *
 * A sibling of `settle-model-predictions`, not a replacement: the directional and
 * volatility alphabets are disjoint and live in separate tables, so they settle
 * separately. Idempotent — already-graded rows are excluded by the query, so a re-run
 * only picks up what has newly matured.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new SettleAuxiliaryPredictions(
      new PostgresAuxiliaryPredictionSettlementRepository(database),
    ).execute();
    console.info(JSON.stringify({
      level: "info",
      message: "Auxiliary prediction settlement complete",
      ...result,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
