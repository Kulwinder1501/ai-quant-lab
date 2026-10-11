import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { deriveHigherTimeframeCandles } from "../../modules/market-data/application/derive-higher-timeframe-candles.js";
import { parseDateOption, requireOption } from "./arguments.js";
import type { Instrument } from "../../modules/market-data/domain/instrument.js";

/**
 * Rolls one instrument's already-collected 1m candles up into longer timeframes locally -- see
 * `derive-higher-timeframe-candles.ts` for why. The 1m series must already be collected for this
 * range first, e.g.:
 *
 *   npm run data:collect:historical -- --provider oanda --exchange OANDA \
 *     --instrument XAU_USD --timeframe 1m --from <from> --to <to> --skip-existing
 *   npm run data:derive:higher-timeframes -- --exchange OANDA --instrument XAU_USD \
 *     --timeframes 5,15 --from <from> --to <to>
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const exchange = requireOption(argumentsList, "exchange").toUpperCase() as Instrument["exchange"];
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const from = parseDateOption(requireOption(argumentsList, "from"), false);
    const to = parseDateOption(requireOption(argumentsList, "to"), true);
    const bucketMinutesList = requireOption(argumentsList, "timeframes").split(",").map((raw) => {
      const minutes = Number(raw.trim());
      if (!Number.isInteger(minutes) || minutes < 2) {
        throw new Error(`--timeframes must be a comma-separated list of integer minute counts >= 2, got "${raw}".`);
      }
      return minutes;
    });

    const instrumentRepository = new PostgresInstrumentRepository(database);
    const instrument = await instrumentRepository.findByExchangeAndSymbol(exchange, symbol);
    if (!instrument) throw new Error(`${exchange} instrument "${symbol}" is not registered.`);

    const provenance = await database.query<{ source: string }>(
      `SELECT source FROM candle_series_provenance WHERE instrument_id = $1 AND timeframe = '1m'`,
      [instrument.id],
    );
    const source = provenance.rows[0]?.source;
    if (!source) {
      throw new Error(
        `No candle_series_provenance row for ${symbol} 1m -- its 1m series has never been collected, `
        + "so there is nothing to derive from.",
      );
    }

    const candleRepository = new PostgresCandleRepository(database);
    const results = await deriveHigherTimeframeCandles(database, candleRepository, {
      instrumentId: instrument.id,
      source,
      from,
      to,
      bucketMinutesList,
    });
    console.info(JSON.stringify({ level: "info", message: "Derived higher-timeframe candles", symbol, results }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
