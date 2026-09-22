import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { quoteLabSymbol, quoteLabSymbols } from "./yahoo-quote-client.js";

const yahooReader: MarketQuoteReader = {
  quoteSymbol: quoteLabSymbol,
  quoteSymbols: quoteLabSymbols,
};

/**
 * Indian exchange symbols are Fyers-only. Yahoo is retained for symbols Fyers has no segment
 * for: foreign indices, whose canonical keys begin with `^`, and already-Yahoo-qualified
 * futures/forex tickers such as `XAUUSD=X`, which contain `=` -- the same escape hatch
 * `resolveYahooSymbol` already recognizes as "not an NSE equity guess". A Fyers outage
 * therefore cannot silently change the provider used by the bot, portfolio, or driver tape.
 */
function isForeignSymbol(symbol: string): boolean {
  const trimmed = symbol.trim();
  return trimmed.startsWith("^") || trimmed.includes("=");
}

export class ProviderRoutedQuoteClient implements MarketQuoteReader {
  constructor(
    private readonly fyers: MarketQuoteReader | null,
    private readonly foreign: MarketQuoteReader = yahooReader,
  ) {}

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const indian = symbols.filter((symbol) => !isForeignSymbol(symbol));
    const foreign = symbols.filter((symbol) => isForeignSymbol(symbol));
    const [indianQuotes, foreignQuotes] = await Promise.all([
      this.fyers === null || indian.length === 0
        ? Promise.resolve(new Map<string, MarketQuote>())
        : this.fyers.quoteSymbols(indian),
      foreign.length === 0
        ? Promise.resolve(new Map<string, MarketQuote>())
        : this.foreign.quoteSymbols(foreign),
    ]);
    return new Map([...indianQuotes, ...foreignQuotes]);
  }
}

