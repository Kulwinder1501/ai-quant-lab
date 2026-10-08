import { resolveOandaSymbol } from "../../modules/market-data/domain/oanda-symbol-resolver.js";
import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";

export interface OandaQuoteClientOptions {
  accountId: string;
  accessToken: string;
  environment?: "practice" | "trade";
  fetch?: typeof fetch;
  baseUrl?: string;
  minRefreshIntervalMs?: number;
  now?: () => number;
}

interface CacheEntry {
  quote: MarketQuote | null;
  fetchedAt: number;
}

interface OandaPrice {
  instrument: string;
  time: string;
  bids: Array<{ price: string; liquidity: number }>;
  asks: Array<{ price: string; liquidity: number }>;
  closeoutBid: string;
  closeoutAsk: string;
  status: string;
  tradeable: boolean;
}

interface OandaPricingResponse {
  prices?: OandaPrice[];
  errorMessage?: string;
}

export class OandaQuoteClient implements MarketQuoteReader {
  private readonly accountId: string;
  private readonly accessToken: string;
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly minRefreshIntervalMs: number;
  private readonly now: () => number;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: OandaQuoteClientOptions) {
    if (!options.accountId) throw new Error("OandaQuoteClient requires an accountId.");
    if (!options.accessToken) throw new Error("OandaQuoteClient requires an accessToken.");

    this.accountId = options.accountId;
    this.accessToken = options.accessToken;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    
    if (options.baseUrl) {
      this.baseUrl = options.baseUrl;
    } else {
      this.baseUrl = options.environment === "trade" 
        ? "https://api-fxtrade.oanda.com" 
        : "https://api-fxpractice.oanda.com";
    }
    
    // Default 500ms cache to prevent aggressive hammering in the same event loop,
    // though OANDA rate limits are much higher than Twelve Data's 8/minute.
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    if (symbols.length === 0) return new Map();

    const result = new Map<string, MarketQuote>();
    const nowMs = this.now();
    const needed: string[] = [];

    // Check cache
    for (const sym of symbols) {
      const cached = this.cache.get(sym);
      if (cached && nowMs - cached.fetchedAt < this.minRefreshIntervalMs) {
        if (cached.quote) result.set(sym, cached.quote);
      } else {
        needed.push(sym);
      }
    }

    if (needed.length === 0) return result;

    const mappedNeeded = needed.map(resolveOandaSymbol);
    const instrumentString = mappedNeeded.join(",");

    const url = new URL(`/v3/accounts/${this.accountId}/pricing`, this.baseUrl);
    url.searchParams.set("instruments", instrumentString);

    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Accept-Datetime-Format": "RFC3339",
      },
    });

    if (!response.ok) {
      if (response.status === 404 || response.status === 400) {
        // Likely invalid symbol requested
        for (const sym of needed) {
          this.cache.set(sym, { quote: null, fetchedAt: nowMs });
        }
        return result;
      }
      throw new Error(`OANDA pricing failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OandaPricingResponse;

    if (payload.errorMessage) {
      throw new Error(`OANDA pricing error: ${payload.errorMessage}`);
    }

    const prices = payload.prices ?? [];
    const returnedMap = new Map<string, OandaPrice>(
      prices.map(p => [p.instrument, p])
    );

    for (let i = 0; i < needed.length; i++) {
      const originalSym = needed[i];
      const mappedSym = mappedNeeded[i];
      const priceData = returnedMap.get(mappedSym);

      if (!priceData || !priceData.tradeable || priceData.bids.length === 0 || priceData.asks.length === 0) {
        this.cache.set(originalSym, { quote: null, fetchedAt: nowMs });
        continue;
      }

      // We approximate the "current" price as the mid price of the top of book.
      // Alternatively, we just take the bid. Using mid is standard for OANDA quotes.
      const bid = parseFloat(priceData.bids[0].price);
      const ask = parseFloat(priceData.asks[0].price);
      const mid = (bid + ask) / 2.0;
      
      const quoteTime = new Date(priceData.time).getTime();

      const quote: MarketQuote = {
        symbol: originalSym,
        provider: "oanda",
        shortName: null,
        exchange: "OANDA",
        regularMarketPrice: mid,
        regularMarketPreviousClose: null,
        regularMarketChange: null,
        regularMarketChangePercent: null,
        regularMarketOpen: null,
        regularMarketDayHigh: null,
        regularMarketDayLow: null,
        regularMarketVolume: 0,
        regularMarketTime: new Date(quoteTime),
        bid,
        ask,
      };

      this.cache.set(originalSym, { quote, fetchedAt: nowMs });
      result.set(originalSym, quote);
    }

    return result;
  }
}
