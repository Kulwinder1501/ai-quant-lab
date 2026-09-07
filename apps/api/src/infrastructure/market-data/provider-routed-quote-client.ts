import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { quoteLabSymbol, quoteLabSymbols } from "./yahoo-quote-client.js";

const yahooReader: MarketQuoteReader = {
  quoteSymbol: quoteLabSymbol,
  quoteSymbols: quoteLabSymbols,
};

/**
 * Indian exchange symbols are Fyers-only. Yahoo is retained solely for foreign indices whose
 * canonical keys begin with `^`; a Fyers outage therefore cannot silently change the provider
 * used by the bot, portfolio, or driver tape.
 */
export class ProviderRoutedQuoteClient implements MarketQuoteReader {
  constructor(
    private readonly fyers: MarketQuoteReader | null,
    private readonly foreign: MarketQuoteReader = yahooReader,
  ) {}

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const indian = symbols.filter((symbol) => !symbol.trim().startsWith("^"));
    const foreign = symbols.filter((symbol) => symbol.trim().startsWith("^"));
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

