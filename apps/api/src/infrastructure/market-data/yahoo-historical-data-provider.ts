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

    return quotes
      // Yahoo emits rows with null OHLC for exchange holidays and for a bar that
      // has not settled yet. Coercing those to 0 with `row.open || 0` produced a
      // candle with a zero price, which the importer correctly rejects as invalid
      // OHLC — so one holiday in the requested range failed the whole backfill.
      // A row without a price is absent data, not a zero price, so it is skipped.
      .filter((row: any) => [row.open, row.high, row.low, row.close].every(
        (price) => typeof price === "number" && Number.isFinite(price) && price > 0,
      ))
      .map((row: any) => {
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
          open: String(row.open),
          high: String(row.high),
          low: String(row.low),
          close: String(row.close),
          // Volume genuinely is absent on an index series, so zero is the honest
          // value here rather than a placeholder for a missing number.
          volume: String(Number.isFinite(row.volume) ? row.volume : 0),
        };
      });
  }
}
