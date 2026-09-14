import { describe, expect, it, vi } from "vitest";
import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { ProviderRoutedQuoteClient } from "./provider-routed-quote-client.js";

function quote(symbol: string, provider: MarketQuote["provider"]): MarketQuote {
  return {
    symbol,
    provider,
    shortName: symbol,
    exchange: null,
    regularMarketPrice: 100,
    regularMarketPreviousClose: null,
    regularMarketChange: null,
    regularMarketChangePercent: null,
    regularMarketOpen: null,
    regularMarketDayHigh: null,
    regularMarketDayLow: null,
    regularMarketVolume: null,
    regularMarketTime: null,
  };
}

function reader(provider: MarketQuote["provider"]): MarketQuoteReader {
  return {
    quoteSymbol: vi.fn(),
    quoteSymbols: vi.fn(async (symbols: readonly string[]) => new Map<string, MarketQuote>(
      symbols.map((symbol) => [symbol, quote(symbol, provider)]),
    )),
  };
}

describe("ProviderRoutedQuoteClient", () => {
  it("routes Indian exchange symbols only to Fyers and foreign indices to Yahoo", async () => {
    const fyers = reader("fyers-api-v3");
    const foreign = reader("yahoo");
    const client = new ProviderRoutedQuoteClient(fyers, foreign);

    const result = await client.quoteSymbols(["NIFTY50", "SBIN", "^GSPC"]);

    expect(fyers.quoteSymbols).toHaveBeenCalledWith(["NIFTY50", "SBIN"]);
    expect(foreign.quoteSymbols).toHaveBeenCalledWith(["^GSPC"]);
    expect(result.get("NIFTY50")?.provider).toBe("fyers-api-v3");
    expect(result.get("^GSPC")?.provider).toBe("yahoo");
  });

  it("returns no Indian quote when Fyers is unconfigured and never calls Yahoo", async () => {
    const foreign = reader("yahoo");
    const client = new ProviderRoutedQuoteClient(null, foreign);

    await expect(client.quoteSymbol("BANKNIFTY")).resolves.toBeNull();
    expect(foreign.quoteSymbols).not.toHaveBeenCalled();
  });

  it("propagates a Fyers failure without provider fallback", async () => {
    const fyers = reader("fyers-api-v3");
    vi.mocked(fyers.quoteSymbols).mockRejectedValue(new Error("Fyers unavailable"));
    const foreign = reader("yahoo");
    const client = new ProviderRoutedQuoteClient(fyers, foreign);

    await expect(client.quoteSymbol("NIFTY50")).rejects.toThrow("Fyers unavailable");
    expect(foreign.quoteSymbols).not.toHaveBeenCalled();
  });
});
