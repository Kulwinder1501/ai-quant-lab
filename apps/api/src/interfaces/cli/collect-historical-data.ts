import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import { CsvHistoricalDataProvider } from "../../infrastructure/market-data/csv-historical-data-provider.js";
import { FyersHistoricalDataProvider } from "../../infrastructure/market-data/fyers-historical-data-provider.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { KiteHistoricalDataProvider } from "../../infrastructure/market-data/kite-historical-data-provider.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketDataIngestionRepository } from "../../infrastructure/database/repositories/postgres-market-data-ingestion-repository.js";
import { ImportHistoricalMarketData } from "../../modules/market-data/application/import-historical-market-data.js";
import type { HistoricalMarketDataProvider } from "../../modules/market-data/domain/historical-data-provider.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

import { YahooHistoricalDataProvider } from "../../infrastructure/market-data/yahoo-historical-data-provider.js";

function providerFromArguments(
  argumentsList: string[],
  database: DatabasePool,
): HistoricalMarketDataProvider {
  const provider = requireOption(argumentsList, "provider").toLowerCase();
  if (provider === "csv") {
    return new CsvHistoricalDataProvider({ filePath: requireOption(argumentsList, "file") });
  }
  if (provider === "fyers") {
    const appId = process.env.FYERS_APP_ID;
    const appSecret = process.env.FYERS_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error("Fyers collection requires FYERS_APP_ID and FYERS_APP_SECRET in .env.");
    }
    return new FyersHistoricalDataProvider({
      appId,
      tokenService: new FyersTokenService({
        pool: database,
        appId,
        appSecret,
        pin: process.env.FYERS_PIN ?? "",
      }),
    });
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
  throw new Error(`Unsupported provider "${provider}". Use csv, fyers, kite, or yahoo.`);
}

/**
 * Provenance is partitioned by timeframe, not by date, so no series is ever half
 * Fyers and half Yahoo. A mixed series would mean training on one provider's bars and
 * inferring on another's — train/serve skew introduced at the data layer, where it is
 * nearly invisible.
 */
const timeframeOwner: Record<string, "fyers" | "yahoo"> = {
  "1m": "fyers", "3m": "fyers", "5m": "fyers", "10m": "fyers",
  "15m": "yahoo", "30m": "yahoo", "60m": "yahoo", "1d": "yahoo",
};

/**
 * Instruments whose every timeframe stays Yahoo-owned regardless of the table above.
 *
 * The Fyers partition exists for tradable price series (indices, ETF proxies,
 * futures) where intraday history was re-sourced from Fyers. INDIAVIX is not part of
 * that program: its 1m/5m/15m series has only ever been Yahoo-sourced, the
 * INDIA_VIX_INTRADAY scheduler job collects it via Yahoo every five minutes, and
 * re-sourcing it would itself be the provider mix the partition forbids.
 */
const yahooOwnedInstruments = new Set(["INDIAVIX"]);

function assertProviderOwnsTimeframe(provider: string, timeframe: string, symbol: string): void {
  const owner = yahooOwnedInstruments.has(symbol.toUpperCase()) ? "yahoo" : timeframeOwner[timeframe];
  // csv and kite are manual escape hatches and are not part of the partition.
  if (!owner || (provider !== "fyers" && provider !== "yahoo")) return;
  if (provider !== owner) {
    throw new Error(
      `The ${symbol} ${timeframe} series is owned by ${owner}, not ${provider}. Mixing providers within `
      + `one series creates train/serve skew. Pass --allow-foreign-provider only if you are `
      + `deliberately reassigning ownership and have planned the purge of the existing rows.`,
    );
  }
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

    const provider = providerFromArguments(argumentsList, database);
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    if (!argumentsList.includes("--allow-foreign-provider")) {
      assertProviderOwnsTimeframe(
        requireOption(argumentsList, "provider").toLowerCase(),
        timeframe,
        symbol,
      );
    }
    const from = parseDateOption(requireOption(argumentsList, "from"), false);
    const to = parseDateOption(requireOption(argumentsList, "to"), true);
    const providerInstrumentId = getOption(argumentsList, "provider-instrument-id") ?? instrument.symbol;
    // Presence flag: `--skip-existing` makes an overlapping backfill idempotent
    // instead of aborting on the first already-stored (and possibly provider-
    // revised) date. Absent → strict immutability, unchanged.
    const skipExisting = argumentsList.includes("--skip-existing");
    // `--skip-invalid` drops corrupt upstream prints with a reported count instead of
    // aborting. Needed for bulk provider backfills; never silent.
    const skipInvalid = argumentsList.includes("--skip-invalid");
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
      skipExisting,
      skipInvalid,
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
