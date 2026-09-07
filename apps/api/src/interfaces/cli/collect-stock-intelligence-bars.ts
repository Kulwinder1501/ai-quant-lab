import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { YahooHistoricalDataProvider } from "../../infrastructure/market-data/yahoo-historical-data-provider.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { IngestMarketBars } from "../../modules/stock-intelligence/application/ingest-market-bars.js";
import { YahooMarketDataAdapter } from "../../modules/stock-intelligence/application/yahoo-market-data-adapter.js";
import {
  HISTORICAL_REPLAY_WINDOW_FROM,
  HISTORICAL_REPLAY_WINDOW_TO,
} from "../../modules/stock-intelligence/domain/replay.js";
import { stockIntelligenceUniverses, type StockIntelligenceUniverse } from "../../modules/stock-intelligence/domain/universe.js";
import { getOption, parseDateOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const from = parseDateOption(getOption(argumentsList, "from") ?? HISTORICAL_REPLAY_WINDOW_FROM, false);
  const to = parseDateOption(getOption(argumentsList, "to") ?? HISTORICAL_REPLAY_WINDOW_TO, true);
  const cutoffRaw = getOption(argumentsList, "data-cutoff");
  const dataCutoff = cutoffRaw ? parseDateOption(cutoffRaw, true) : to;
  const onlySymbol = getOption(argumentsList, "symbol")?.toUpperCase();
  const universeRaw = getOption(argumentsList, "universe")?.toUpperCase();
  if (universeRaw && !stockIntelligenceUniverses.includes(universeRaw as StockIntelligenceUniverse)) {
    throw new Error(`Unsupported universe "${universeRaw}". Expected ${stockIntelligenceUniverses.join(", ")}.`);
  }
  const universe = universeRaw as StockIntelligenceUniverse | undefined;

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const instruments = new PostgresInstrumentRepository(database);
    const store = new PostgresStockIntelligenceStore(database);
    const ingest = new IngestMarketBars(new YahooMarketDataAdapter(new YahooHistoricalDataProvider()), store);
    const memberships = await store.listAllMemberships(universe ? [universe] : undefined);
    const ids = [...new Set(memberships.map((row) => row.instrumentId))];
    const summaries = [];
    const failures: Array<{ instrumentId: string; symbol: string; error: string }> = [];

    for (const instrumentId of ids) {
      const instrument = await instruments.findById(instrumentId);
      if (!instrument) continue;
      if (onlySymbol && instrument.symbol !== onlySymbol) continue;
      let result;
      try {
        result = await ingest.execute({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          instrumentType: instrument.instrumentType,
          from,
          to,
          dataCutoff,
        });
      } catch (error) {
        const failure = {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          error: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        console.warn(JSON.stringify({
          level: "warn",
          message: "Stock Intelligence bars unavailable; continuing",
          ...failure,
        }));
        continue;
      }
      summaries.push({
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        instrumentType: instrument.instrumentType,
        ...result,
      });
      console.info(JSON.stringify({
        level: "info",
        message: "Stock Intelligence bars ingested",
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        dataCutoff: dataCutoff.toISOString(),
        ...result,
      }));
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence bar collection finished",
      from: from.toISOString(),
      to: to.toISOString(),
      universe: universe ?? "ALL",
      instruments: summaries.length,
      inserted: summaries.reduce((sum, row) => sum + row.inserted, 0),
      skippedExisting: summaries.reduce((sum, row) => sum + row.skippedExisting, 0),
      skippedUnverified: summaries.filter((row) => row.skippedReason === "YAHOO_TICKER_UNVERIFIED").length,
      failed: failures.length,
      failures,
    }));
    if (failures.length > 0) process.exitCode = 2;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
