import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { seedCoreInstruments } from "../../modules/market-data/application/seed-core-instruments.js";
import { seedMarketData } from "../../modules/market-data/application/seed-market-data.js";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const instruments = await seedCoreInstruments(new PostgresInstrumentRepository(database));
    console.info(JSON.stringify({ level: "info", message: "Core instruments seeded", symbols: instruments.map((instrument) => instrument.symbol) }));
    await seedMarketData(database);
    console.info(JSON.stringify({ level: "info", message: "Historical market data, indicators, patterns, strategies, and trade ideas seeded" }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
