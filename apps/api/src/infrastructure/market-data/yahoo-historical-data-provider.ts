import yahooFinance from "yahoo-finance2";
import type {
  HistoricalMarketCandle,
  HistoricalMarketDataProvider,
  HistoricalMarketDataRequest,
} from "../../modules/market-data/domain/historical-data-provider.js";
import { resolveYahooSymbol } from "../../modules/market-data/domain/yahoo-symbol-resolver.js";

function getYahooInterval(timeframe: string): "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "90m" | "1h" | "1d" | "5d" | "1wk" | "1mo" | "3mo" {
  switch (timeframe) {
    case "1m": return "1m";
    case "3m": return "1m"; // Yahoo doesn't support 3m natively
    case "5m": return "5m";
    case "10m": return "5m";
    case "15m": return "15m";
    case "30m": return "30m";
    case "60m": return "60m";
    case "1d": return "1d";
    default: return "1d";
  }
}

export class YahooHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = "yahoo";

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const yfSymbol = resolveYahooSymbol(request.providerInstrumentId);

    const interval = getYahooInterval(request.timeframe);

    const queryOptions = {
      period1: request.from,
      period2: request.to,
      interval,
    };

    const yf = new (yahooFinance as any)({ suppressNotices: ['ripHistorical'] });
    const results = await yf.chart(yfSymbol, queryOptions);
    const quotes = results.quotes || [];

    return quotes.map((row: any) => {
      // Calculate closeTime by adding timeframe minutes
      const openTime = new Date(row.date);
      let durationMs = 0;
      if (request.timeframe.endsWith("m")) {
        durationMs = parseInt(request.timeframe.replace("m", ""), 10) * 60000;
      } else if (request.timeframe.endsWith("d")) {
        durationMs = parseInt(request.timeframe.replace("d", ""), 10) * 86400000;
      }
      const closeTime = new Date(openTime.getTime() + durationMs);

      return {
        openTime,
        closeTime,
        open: String(row.open || 0),
        high: String(row.high || 0),
        low: String(row.low || 0),
        close: String(row.close || 0),
        volume: String(row.volume || 0),
      };
    });
  }
}
