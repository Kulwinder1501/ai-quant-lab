export interface MarketQuote {
  symbol: string;
  provider: "fyers-api-v3" | "yahoo";
  shortName: string | null;
  exchange: string | null;
  regularMarketPrice: number | null;
  regularMarketPreviousClose: number | null;
  regularMarketChange: number | null;
  regularMarketChangePercent: number | null;
  regularMarketOpen: number | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  regularMarketTime: Date | null;
}

export interface MarketQuoteReader {
  quoteSymbol(symbol: string): Promise<MarketQuote | null>;
  quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>>;
}

