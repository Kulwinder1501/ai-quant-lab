import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { ImportWikipediaNifty50History } from "../../modules/stock-intelligence/application/import-wikipedia-nifty50-history.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new ImportWikipediaNifty50History(
      new PostgresInstrumentRepository(database),
      new PostgresStockIntelligenceStore(database),
    ).execute();
    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence NIFTY 50 historical membership imported",
      method: "wikipedia_cc_by_sa_month_end_reconstruction",
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
