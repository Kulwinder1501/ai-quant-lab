import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { RecordPredictionDecay } from "../../modules/stock-intelligence/application/record-prediction-decay.js";
import { getOption, parseDateOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const asOfRaw = getOption(argumentsList, "as-of");
  const asOf = asOfRaw ? parseDateOption(asOfRaw, true) : new Date();

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const store = new PostgresStockIntelligenceStore(database);
    const result = await new RecordPredictionDecay(store).execute({ asOf });
    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence prediction decay",
      method: "prediction_decay_schedule",
      asOf: asOf.toISOString(),
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
