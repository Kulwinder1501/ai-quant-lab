import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersHistoricalDataProvider } from "../../infrastructure/market-data/fyers-historical-data-provider.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketDataIngestionRepository } from "../../infrastructure/database/repositories/postgres-market-data-ingestion-repository.js";
import { ImportHistoricalMarketData } from "../../modules/market-data/application/import-historical-market-data.js";
import { getOption, parseDateOption } from "./arguments.js";

/**
 * Phase 0 FRVP data prerequisite: register historically eligible NIFTY/BANKNIFTY monthly
 * index futures and collect Fyers 1m OHLCV with cont_flag=0 (raw per-contract bars, no
 * continuous stitch). See docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md.
 *
 * Usage:
 *   npx tsx src/interfaces/cli/ingest-index-futures-ohlcv.ts
 *   npx tsx src/interfaces/cli/ingest-index-futures-ohlcv.ts --from 2026-07-15 --to 2026-10-12
 */

interface FuturesContractSpec {
  /** Lab symbol (no exchange prefix). */
  symbol: string;
  /** Fyers provider id. */
  providerInstrumentId: string;
  displayName: string;
  underlyingSymbol: "NIFTY50" | "BANKNIFTY";
  /** ISO date YYYY-MM-DD. */
  expiryDate: string;
  lotSize: number;
  /** Inclusive collection window for this contract's liquid/front life. */
  collectFrom: string;
  collectTo: string;
}

/**
 * Monthly contracts covering the lab's known depth window and calendar MONTHLY expiries
 * (Aug–Oct 2026). Earlier months can be appended once the calendar lists them.
 */
const CONTRACTS: readonly FuturesContractSpec[] = [
  {
    symbol: "NIFTY26AUGFUT",
    providerInstrumentId: "NSE:NIFTY26AUGFUT",
    displayName: "NIFTY Aug 2026 Future",
    underlyingSymbol: "NIFTY50",
    expiryDate: "2026-08-25",
    lotSize: 75,
    collectFrom: "2026-07-15",
    collectTo: "2026-08-25",
  },
  {
    symbol: "NIFTY26SEPFUT",
    providerInstrumentId: "NSE:NIFTY26SEPFUT",
    displayName: "NIFTY Sep 2026 Future",
    underlyingSymbol: "NIFTY50",
    expiryDate: "2026-09-29",
    lotSize: 75,
    collectFrom: "2026-08-20",
    collectTo: "2026-09-29",
  },
  {
    symbol: "NIFTY26OCTFUT",
    providerInstrumentId: "NSE:NIFTY26OCTFUT",
    displayName: "NIFTY Oct 2026 Future",
    underlyingSymbol: "NIFTY50",
    expiryDate: "2026-10-27",
    lotSize: 75,
    collectFrom: "2026-09-01",
    collectTo: "2026-10-12",
  },
  {
    symbol: "BANKNIFTY26AUGFUT",
    providerInstrumentId: "NSE:BANKNIFTY26AUGFUT",
    displayName: "BANKNIFTY Aug 2026 Future",
    underlyingSymbol: "BANKNIFTY",
    expiryDate: "2026-08-25",
    lotSize: 30,
    collectFrom: "2026-07-15",
    collectTo: "2026-08-25",
  },
  {
    symbol: "BANKNIFTY26SEPFUT",
    providerInstrumentId: "NSE:BANKNIFTY26SEPFUT",
    displayName: "BANKNIFTY Sep 2026 Future",
    underlyingSymbol: "BANKNIFTY",
    expiryDate: "2026-09-29",
    lotSize: 30,
    collectFrom: "2026-08-20",
    collectTo: "2026-09-29",
  },
  {
    symbol: "BANKNIFTY26OCTFUT",
    providerInstrumentId: "NSE:BANKNIFTY26OCTFUT",
    displayName: "BANKNIFTY Oct 2026 Future",
    underlyingSymbol: "BANKNIFTY",
    expiryDate: "2026-10-27",
    lotSize: 30,
    collectFrom: "2026-09-01",
    collectTo: "2026-10-12",
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const environment = loadEnvironment();
  const appId = process.env.FYERS_APP_ID;
  const appSecret = process.env.FYERS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("FYERS_APP_ID and FYERS_APP_SECRET are required.");
  }

  const globalFrom = getOption(args, "from");
  const globalTo = getOption(args, "to");
  const only = getOption(args, "symbol")?.toUpperCase();

  const database = createDatabasePool(environment.DATABASE_URL);
  const instruments = new PostgresInstrumentRepository(database);
  const importer = new ImportHistoricalMarketData(
    new PostgresMarketDataIngestionRepository(database),
    new PostgresCandleRepository(database),
  );
  const provider = new FyersHistoricalDataProvider({
    appId,
    tokenService: new FyersTokenService({
      pool: database,
      appId,
      appSecret,
      pin: process.env.FYERS_PIN ?? "",
    }),
  });

  const results: unknown[] = [];
  try {
    for (const contract of CONTRACTS) {
      if (only && contract.symbol !== only) continue;

      const instrument = await instruments.upsert({
        exchange: "NSE",
        symbol: contract.symbol,
        displayName: contract.displayName,
        instrumentType: "FUTURE",
        currency: "INR",
        tickSize: "0.05",
        lotSize: contract.lotSize,
        underlyingSymbol: contract.underlyingSymbol,
        expiryDate: contract.expiryDate,
        metadata: {
          fyersSymbol: contract.providerInstrumentId,
          expiryKind: "MONTHLY",
          role: "index-future",
          phase0ExperimentId: "FRVP-MSP-P0-2026-10-12",
        },
      });

      // Migration 043 FK: candles require a declared series owner before any insert.
      await database.query(
        `INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
         VALUES ($1, '1m', 'fyers-api-v3')
         ON CONFLICT (instrument_id, timeframe) DO NOTHING`,
        [instrument.id],
      );

      const from = parseDateOption(globalFrom ?? contract.collectFrom, false);
      const to = parseDateOption(globalTo ?? contract.collectTo, true);

      console.info(JSON.stringify({
        level: "info",
        message: "Collecting index futures OHLCV",
        symbol: contract.symbol,
        providerInstrumentId: contract.providerInstrumentId,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        instrumentId: instrument.id,
      }));

      try {
        const result = await importer.execute({
          instrument,
          provider,
          providerInstrumentId: contract.providerInstrumentId,
          timeframe: "1m",
          from,
          to,
          skipExisting: true,
          skipInvalid: true,
        });
        results.push({
          symbol: contract.symbol,
          providerInstrumentId: contract.providerInstrumentId,
          expiryDate: contract.expiryDate,
          underlyingSymbol: contract.underlyingSymbol,
          status: "ok",
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          level: "error",
          message: "Index futures OHLCV collect failed for contract",
          symbol: contract.symbol,
          detail: message,
        }));
        results.push({
          symbol: contract.symbol,
          providerInstrumentId: contract.providerInstrumentId,
          status: "failed",
          error: message,
        });
      }
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Index futures OHLCV ingest complete",
      contracts: results.length,
      results,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
