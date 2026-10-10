import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { quoteLabSymbols } from "../../infrastructure/market-data/yahoo-quote-client.js";
import { PostgresOpeningGapPredictionRepository } from "../../infrastructure/database/repositories/postgres-opening-gap-prediction-repository.js";
import { PredictOpeningGap, type GlobalCueQuote, type GlobalCueSource } from "../../modules/market-data/application/predict-opening-gap.js";

const yahooCueSource: GlobalCueSource = {
  async getChangePercents(symbols) {
    const quotes = await quoteLabSymbols(symbols);
    const result = new Map<string, GlobalCueQuote>();
    for (const symbol of symbols) {
      const quote = quotes.get(symbol);
      result.set(symbol, { changePercent: quote?.regularMarketChangePercent ?? null });
    }
    return result;
  },
};

/**
 * Runs once pre-market (see scheduler.ts, ~08:50 IST) to predict NIFTY50/BANKNIFTY's opening
 * gap from the S&P 500's own overnight change. Exit code 2 (not 1) when the driver quote is
 * simply unavailable -- a US market holiday or a Yahoo outage is an absent-data day, not a
 * crash, and the scheduler's retry/alerting should be able to tell the two apart.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new PredictOpeningGap(
      yahooCueSource,
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
