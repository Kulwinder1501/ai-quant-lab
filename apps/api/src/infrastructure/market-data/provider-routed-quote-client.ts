import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { quoteLabSymbol, quoteLabSymbols } from "./yahoo-quote-client.js";
import { TWELVEDATA_MAPPED_SYMBOLS } from "../../modules/market-data/domain/twelvedata-symbol-resolver.js";

const yahooReader: MarketQuoteReader = {
  quoteSymbol: quoteLabSymbol,
  quoteSymbols: quoteLabSymbols,
};

const twelveDataMappedSymbols = new Set(TWELVEDATA_MAPPED_SYMBOLS);

/**
 * Indian exchange symbols are Fyers-only. Yahoo serves symbols Fyers has no segment for whose
 * canonical keys begin with `^` (foreign indices) or contain `=` (already-Yahoo-qualified
 * futures/forex tickers) -- the same escape hatch `resolveYahooSymbol` already recognizes as
 * "not an NSE equity guess". Twelve Data serves whatever it has its own canonical mapping for
 * (checked first, from `twelvedata-symbol-resolver.ts`, so it doesn't have to fit either of the
 * other two naming conventions). A Fyers outage therefore cannot silently change the provider
 * used by the bot, portfolio, or driver tape.
 */
function isYahooSymbol(symbol: string): boolean {
  const trimmed = symbol.trim();
  return trimmed.startsWith("^") || trimmed.includes("=");
}

export class ProviderRoutedQuoteClient implements MarketQuoteReader {
  constructor(
    private readonly fyers: MarketQuoteReader | null,
    private readonly foreign: MarketQuoteReader = yahooReader,
    private readonly twelveData: MarketQuoteReader | null = null,
  ) {}

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const twelveDataOwned = symbols.filter((symbol) => twelveDataMappedSymbols.has(symbol.trim().toUpperCase()));
    const remaining = symbols.filter((symbol) => !twelveDataMappedSymbols.has(symbol.trim().toUpperCase()));
    const indian = remaining.filter((symbol) => !isYahooSymbol(symbol));
    const foreign = remaining.filter((symbol) => isYahooSymbol(symbol));
    const [twelveDataQuotes, indianQuotes, foreignQuotes] = await Promise.all([
      this.twelveData === null || twelveDataOwned.length === 0
        ? Promise.resolve(new Map<string, MarketQuote>())
        : this.twelveData.quoteSymbols(twelveDataOwned),
      this.fyers === null || indian.length === 0
        ? Promise.resolve(new Map<string, MarketQuote>())
        : this.fyers.quoteSymbols(indian),
      foreign.length === 0
        ? Promise.resolve(new Map<string, MarketQuote>())
        : this.foreign.quoteSymbols(foreign),
    ]);
    return new Map([...twelveDataQuotes, ...indianQuotes, ...foreignQuotes]);
  }
}

