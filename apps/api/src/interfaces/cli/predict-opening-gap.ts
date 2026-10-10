import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { quoteLabSymbols } from "../../infrastructure/market-data/yahoo-quote-client.js";
import { NseIxClient } from "../../infrastructure/external/nse-ix-client.js";
import { PostgresOpeningGapPredictionRepository } from "../../infrastructure/database/repositories/postgres-opening-gap-prediction-repository.js";
import {
  PredictOpeningGap,
  OPENING_GAP_DRIVER_SYMBOL,
  type GlobalCueQuote,
  type GlobalCueSource,
} from "../../modules/market-data/application/predict-opening-gap.js";

const nseIx = new NseIxClient();

/**
 * Routes the driver symbol to NSE IX and everything else to Yahoo. `PredictOpeningGap` itself
 * only knows "a change percent keyed by symbol" -- it has no idea GIFT Nifty and the S&P 500
 * come from two completely different providers, which is the point: swapping the driver's
 * source again later (another NSE IX field, a paid feed) only touches this file.
 *
 * A GIFT Nifty fetch failure (NSE IX down, outside its ~21-hour trading window, a changed
 * payload shape) is caught here and treated as "no quote today", not a crash: this is a daily
 * research prediction, not an order, so a transient outage should cost one day's row, not an
 * alert-worthy process exit.
 */
const liveCueSource: GlobalCueSource = {
  async getChangePercents(symbols) {
    const result = new Map<string, GlobalCueQuote>();
    const yahooSymbols = symbols.filter((symbol) => symbol !== OPENING_GAP_DRIVER_SYMBOL);

    if (symbols.includes(OPENING_GAP_DRIVER_SYMBOL)) {
      let changePercent: number | null = null;
      try {
        const quote = await nseIx.getGiftNiftyFuturesQuote();
        changePercent = quote?.changePercent ?? null;
      } catch (error) {
        console.error(JSON.stringify({ level: "warn", message: "GIFT Nifty fetch failed", error: String(error) }));
      }
      result.set(OPENING_GAP_DRIVER_SYMBOL, { changePercent });
    }

    if (yahooSymbols.length > 0) {
      const quotes = await quoteLabSymbols(yahooSymbols);
      for (const symbol of yahooSymbols) {
        result.set(symbol, { changePercent: quotes.get(symbol)?.regularMarketChangePercent ?? null });
      }
    }

    return result;
  },
};

/**
 * Runs once pre-market (see scheduler.ts, ~08:50 IST) to predict NIFTY50/BANKNIFTY's opening
 * gap from GIFT Nifty's own overnight change. Exit code 2 (not 1) when the driver quote is
 * simply unavailable -- an NSE IX outage is an absent-data day, not a crash, and the
 * scheduler's retry/alerting should be able to tell the two apart.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new PredictOpeningGap(
      liveCueSource,
      new PostgresOpeningGapPredictionRepository(database),
    ).execute();
    console.info(JSON.stringify({ level: "info", message: "Opening gap prediction complete", ...result }));
    if (!result.driverAvailable) {
      process.exitCode = 2;
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
