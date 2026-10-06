import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { computeSyntheticDxyCandles } from "../../modules/market-data/application/compute-synthetic-dxy-candles.js";
import { parseDateOption, requireOption } from "./arguments.js";

/**
 * Rebuilds the synthetic DXY 1m/5m/15m series for [--from, --to) from its 6 real component
 * pairs' already-collected candles (see `synthetic-dxy.ts` for why DXY itself has no real
 * Twelve Data ticker). The components must already be collected for this range first, e.g.:
 *
 *   for s in EUR_USD USD_JPY GBP_USD USD_CAD USD_SEK USD_CHF; do
 *     npm run data:collect:historical -- --provider twelvedata --exchange TWELVEDATA \
 *       --instrument $s --timeframe 1m --from <from> --to <to> --skip-existing
 *   done
 *   npm run data:compute:synthetic-dxy -- --from <from> --to <to>
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const from = parseDateOption(requireOption(argumentsList, "from"), false);
    const to = parseDateOption(requireOption(argumentsList, "to"), true);
    const candleRepository = new PostgresCandleRepository(database);
    const result = await computeSyntheticDxyCandles(database, candleRepository, from, to);
    console.info(JSON.stringify({ level: "info", message: "Synthetic DXY computation complete", ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
