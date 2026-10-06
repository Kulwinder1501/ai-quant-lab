import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersHistoricalDataProvider } from "../../infrastructure/market-data/fyers-historical-data-provider.js";
import { FyersQuoteClient } from "../../infrastructure/market-data/fyers-quote-client.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import type { HistoricalTimeframe } from "../../modules/market-data/domain/historical-data-provider.js";

interface YahooSeries {
  symbol: string;
  timeframe: HistoricalTimeframe;
}

/** Read-only preflight for moving every stored Indian price series to Fyers. */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const appId = environment.FYERS_APP_ID;
  const appSecret = environment.FYERS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Fyers coverage validation requires FYERS_APP_ID and FYERS_APP_SECRET.");
  }

  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const tokenService = new FyersTokenService({
      pool: database,
      appId,
      appSecret,
      pin: environment.FYERS_PIN ?? "",
    });
    const quoteClient = new FyersQuoteClient({ tokenService, appId });
    const history = new FyersHistoricalDataProvider({ tokenService, appId });
    const series = await database.query<YahooSeries>(`
      SELECT i.symbol, p.timeframe
      FROM candle_series_provenance p
      JOIN instruments i ON i.id = p.instrument_id
      WHERE p.source = 'yahoo' AND i.exchange IN ('NSE', 'BSE')
      ORDER BY i.symbol, p.timeframe
    `);

    const symbols = [...new Set([
      "NIFTY50", "BANKNIFTY", "FINNIFTY", "SENSEX", "INDIAVIX",
      ...series.rows.map((row) => row.symbol),
    ])];
    const quotes = await quoteClient.quoteSymbols(symbols);
    const missingQuotes = symbols.filter((symbol) => !quotes.has(symbol));

    const to = new Date();
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60_000);
    const historical: Array<{ symbol: string; timeframe: string; candles: number; error?: string }> = [];
    for (const row of series.rows) {
      try {
        const candles = await history.fetchCandles({
          providerInstrumentId: row.symbol,
          timeframe: row.timeframe,
          from,
          to,
        });
        historical.push({ symbol: row.symbol, timeframe: row.timeframe, candles: candles.length });
      } catch (error) {
        historical.push({
          symbol: row.symbol,
          timeframe: row.timeframe,
          candles: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const missingHistory = historical.filter((row) => row.candles === 0);
    console.info(JSON.stringify({
      provider: "fyers-api-v3",
      quotes: { requested: symbols.length, received: quotes.size, missing: missingQuotes },
      historical: {
        requestedSeries: historical.length,
        coveredSeries: historical.length - missingHistory.length,
        missing: missingHistory,
      },
    }, null, 2));

    if (missingQuotes.length > 0 || missingHistory.length > 0) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
