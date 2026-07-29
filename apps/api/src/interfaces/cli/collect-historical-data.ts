import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { CsvHistoricalDataProvider } from "../../infrastructure/market-data/csv-historical-data-provider.js";
import { KiteHistoricalDataProvider } from "../../infrastructure/market-data/kite-historical-data-provider.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketDataIngestionRepository } from "../../infrastructure/database/repositories/postgres-market-data-ingestion-repository.js";
import { ImportHistoricalMarketData } from "../../modules/market-data/application/import-historical-market-data.js";
import type { HistoricalMarketDataProvider } from "../../modules/market-data/domain/historical-data-provider.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

import { YahooHistoricalDataProvider } from "../../infrastructure/market-data/yahoo-historical-data-provider.js";

function providerFromArguments(argumentsList: string[]): HistoricalMarketDataProvider {
  const provider = requireOption(argumentsList, "provider").toLowerCase();
  if (provider === "csv") {
    return new CsvHistoricalDataProvider({ filePath: requireOption(argumentsList, "file") });
  }
  if (provider === "kite") {
    const apiKey = process.env.KITE_API_KEY;
    const accessToken = process.env.KITE_ACCESS_TOKEN;
    if (!apiKey || !accessToken) {
      throw new Error("Kite collection requires KITE_API_KEY and KITE_ACCESS_TOKEN in .env.");
    }
    return new KiteHistoricalDataProvider({ apiKey, accessToken });
  }
  if (provider === "yahoo") {
    return new YahooHistoricalDataProvider();
  }
  throw new Error(`Unsupported provider "${provider}". Use csv, kite, or yahoo.`);
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered. Run data:seed:core-instruments or register it first.`);
    }

    const provider = providerFromArguments(argumentsList);
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const from = parseDateOption(requireOption(argumentsList, "from"), false);
    const to = parseDateOption(requireOption(argumentsList, "to"), true);
    const providerInstrumentId = getOption(argumentsList, "provider-instrument-id") ?? instrument.symbol;
    const service = new ImportHistoricalMarketData(
      new PostgresMarketDataIngestionRepository(database),
      new PostgresCandleRepository(database),
    );
    const result = await service.execute({
      instrument,
      provider,
      providerInstrumentId,
      timeframe,
      from,
      to,
    });
    console.info(JSON.stringify({ level: "info", message: "Historical import complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
