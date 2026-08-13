import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresExpiredProvisionalCandleRepository } from "../../infrastructure/database/repositories/postgres-expired-provisional-candle-repository.js";
import { ReconcileExpiredProvisionalCandles } from "../../modules/market-data/application/reconcile-expired-provisional-candles.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new ReconcileExpiredProvisionalCandles(
      new PostgresExpiredProvisionalCandleRepository(database),
    ).execute();
    console.info(JSON.stringify({
      level: "info",
      message: "Expired provisional candle reconciliation complete",
      closedBefore: result.closedBefore.toISOString(),
      candlesDeleted: result.candlesDeleted,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
