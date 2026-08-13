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
/*
 * Mirrors `candle_series_provenance`, which is now the enforcing copy: a foreign key from
 * `candles` rejects a mismatched source on every write path, not just this CLI. Kept here so
 * the refusal arrives before a long backfill runs rather than on its first insert.
 *
 * 15m moved to Fyers on 2026-08-05. Yahoo serves 15m equities with full volume but only ~2
 * months of history and no index volume at all, and NIFTY50 15m had ended up half Fyers and
 * half Yahoo with volume dropping to zero across the seam.
 */
const timeframeOwner: Record<string, "fyers" | "yahoo"> = {
  "1m": "fyers", "3m": "fyers", "5m": "fyers", "10m": "fyers", "15m": "fyers",
  "30m": "fyers", "60m": "fyers", "1d": "fyers",
};

const providerIds: Record<string, string> = { fyers: "fyers-api-v3", yahoo: "yahoo" };

/**
 * Refuses a provider that does not own this series.
 *
 * Reads `candle_series_provenance` first, because that table is what the foreign key on
 * `candles` enforces -- a static map here would be a second source of truth, and briefly was:
 * flipping it to "15m is Fyers" made the CLI refuse a Yahoo 15m collection for equities whose
 * declaration had legitimately stayed Yahoo. Ownership is per (instrument, timeframe), not per
 * timeframe, so only the table can answer it.
 *
 * The static policy below still applies to a series with no declaration yet, so a brand-new
 * series lands on the intended provider rather than whichever one ran first.
 */
async function assertProviderOwnsTimeframe(
  database: DatabasePool,
  provider: string,
  timeframe: string,
  symbol: string,
  instrumentId: string,
): Promise<void> {
  // csv and kite are manual escape hatches and are not part of the partition.
  if (provider !== "fyers" && provider !== "yahoo") return;

  const declared = await database.query<{ source: string }>(
    "SELECT source FROM candle_series_provenance WHERE instrument_id = $1 AND timeframe = $2",
    [instrumentId, timeframe],
  );
  const declaredSource = declared.rows[0]?.source;
  if (declaredSource) {
    if (providerIds[provider] === declaredSource) return;
    throw new Error(
      `The ${symbol} ${timeframe} series is declared as ${declaredSource}, not ${provider}. `
      + `Mixing providers within one series creates train/serve skew, and the foreign key on `
      + `candles will reject the rows anyway. To reassign: delete that series' candles, update `
      + `candle_series_provenance, then collect.`,
    );
  }

  const owner = timeframeOwner[timeframe];
  if (!owner || provider === owner) return;
  throw new Error(
    `The ${symbol} ${timeframe} series has no declaration yet, and policy assigns a new `
    + `${timeframe} series to ${owner}, not ${provider}. Pass --allow-foreign-provider to `
    + `override deliberately.`,
  );
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
      await assertProviderOwnsTimeframe(
        database,
        requireOption(argumentsList, "provider").toLowerCase(),
        timeframe,
        symbol,
        instrument.id,
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
