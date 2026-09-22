import { resolveTwelveDataSymbol } from "../../modules/market-data/domain/twelvedata-symbol-resolver.js";
import type { MarketQuote } from "../../modules/market-data/domain/market-quote.js";

/**
 * Quote client for Twelve Data's `/quote` endpoint, mirroring `yahoo-quote-client.ts`'s shape
 * so `ProviderRoutedQuoteClient` can treat every provider the same way.
 *
 * No volume: Twelve Data's forex/metals feed has no single consolidated tape for an OTC-style
 * instrument, the same gap `TwelveDataHistoricalDataProvider` already documents for candles.
 */
export interface TwelveDataQuoteClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface TwelveDataQuoteResponse {
  symbol?: string;
  name?: string;
  exchange?: string;
  close?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  open?: string;
  high?: string;
  low?: string;
  /** Epoch seconds of the last actual quote update, distinct from `timestamp` (the current
   * bar's open). Absent on some responses, hence the fallback to `timestamp` below. */
  last_quote_at?: number;
  timestamp?: number;
  status?: string;
  code?: number;
  message?: string;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class TwelveDataQuoteClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TwelveDataQuoteClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Twelve Data quotes require an API key.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.twelvedata.com";
  }

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  /** One request per symbol -- Twelve Data's `/quote` endpoint is single-symbol only, unlike
   * `/time_series`'s batching. The tile list this powers today has exactly one Twelve-Data
   * symbol, so this is not yet a real cost; batching would need `/quote` called per-chunk the
   * way `/time_series` already is if that stops being true. */
  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const result = new Map<string, MarketQuote>();
    await Promise.all(symbols.map(async (symbol) => {
      const quote = await this.fetchOne(symbol);
      if (quote !== null) result.set(symbol, quote);
    }));
    return result;
  }

  private async fetchOne(symbol: string): Promise<MarketQuote | null> {
    let providerSymbol: string;
    try {
      providerSymbol = resolveTwelveDataSymbol(symbol);
    } catch {
      return null;
    }
    const endpoint = new URL("/quote", this.baseUrl);
    endpoint.searchParams.set("symbol", providerSymbol);
    endpoint.searchParams.set("apikey", this.options.apiKey);

    let payload: TwelveDataQuoteResponse | undefined;
    try {
      const response = await this.fetch(endpoint);
      payload = await response.json().catch(() => undefined) as TwelveDataQuoteResponse | undefined;
      if (!response.ok || payload?.status === "error") return null;
    } catch {
      return null;
    }
    if (payload === undefined) return null;

    const price = numberOrNull(payload.close);
    if (price === null || price <= 0) return null;

    const observedAtEpoch = payload.last_quote_at ?? payload.timestamp;
    return {
      symbol,
      provider: "twelvedata",
      shortName: payload.name ?? null,
      exchange: payload.exchange ?? null,
      regularMarketPrice: price,
      regularMarketPreviousClose: numberOrNull(payload.previous_close),
      regularMarketChange: numberOrNull(payload.change),
      regularMarketChangePercent: numberOrNull(payload.percent_change),
      regularMarketOpen: numberOrNull(payload.open),
      regularMarketDayHigh: numberOrNull(payload.high),
      regularMarketDayLow: numberOrNull(payload.low),
      regularMarketVolume: null,
      regularMarketTime: typeof observedAtEpoch === "number" ? new Date(observedAtEpoch * 1000) : null,
    };
  }
}
