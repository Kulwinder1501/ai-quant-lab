import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { YahooCorporateActionAdapter } from "../../infrastructure/market-data/yahoo-corporate-action-adapter.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { IngestCorporateActions } from "../../modules/stock-intelligence/application/ingest-corporate-actions.js";
import { getOption, parseDateOption, requireOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const symbol = requireOption(argumentsList, "symbol").toUpperCase();
  const from = parseDateOption(requireOption(argumentsList, "from"), false);
  const to = parseDateOption(requireOption(argumentsList, "to"), true);
  const cutoffRaw = getOption(argumentsList, "data-cutoff");
  const dataCutoff = cutoffRaw ? parseDateOption(cutoffRaw, true) : to;

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const instruments = new PostgresInstrumentRepository(database);
    const instrument = await instruments.findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`No NSE instrument registered for ${symbol}. Seed the Stock Intelligence universe first.`);
    }
    const result = await new IngestCorporateActions(
      new YahooCorporateActionAdapter(),
      new PostgresStockIntelligenceStore(database),
    ).execute({
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      from,
      to,
      dataCutoff,
    });
    console.info(JSON.stringify({
      level: "info",
      message: "Corporate actions ingested",
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      dataCutoff: dataCutoff.toISOString(),
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
