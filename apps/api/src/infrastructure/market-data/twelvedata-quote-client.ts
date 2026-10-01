import { resolveTwelveDataSymbol } from "../../modules/market-data/domain/twelvedata-symbol-resolver.js";
import type { MarketQuote } from "../../modules/market-data/domain/market-quote.js";

/**
 * Quote client for Twelve Data's `/quote` endpoint, mirroring `yahoo-quote-client.ts`'s shape
 * so `ProviderRoutedQuoteClient` can treat every provider the same way.
 *
 * No volume: Twelve Data's forex/metals feed has no single consolidated tape for an OTC-style
 * instrument, the same gap `TwelveDataHistoricalDataProvider` already documents for candles.
 *
 * Caches per-symbol, with a minimum refresh interval, because the free tier is capped at 8 API
 * credits/minute -- confirmed live on 2026-09-22: a 2.5s poll loop (this codebase's standard
 * cadence, matching `MarketWatchBroadcaster`'s Fyers-sized interval) hit `code: 429, "You have
 * run out of API credits for the current minute... limit being 8"` on its 5th request, well
 * under a minute in. Multiple independent 2.5s pollers (the market-watch broadcaster and
 * `/stream/live-agent`'s poller both go through `ProviderRoutedQuoteClient`, so both can reach
 * this client) made it worse, not better -- credits are shared per key, not per caller. A cache
 * shared across every caller of one instance is what makes the two problems the same fix:
 * `dependencies.ts` constructs exactly one `TwelveDataQuoteClient` and reuses it for both
 * `marketQuoteClient` and `streamingQuoteClient`.
 */
export interface TwelveDataQuoteClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default leaves real headroom under the 8/minute cap even with more than one symbol mapped
   * here later (today there is exactly one, `XAU_USD`). */
  minRefreshIntervalMs?: number;
  now?: () => number;
}

interface CacheEntry {
  quote: MarketQuote | null;
  fetchedAt: number;
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
  private readonly minRefreshIntervalMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  /** De-dupes concurrent callers within the same refresh window onto one in-flight request,
   * rather than each firing its own and spending the credit budget twice for one answer. */
  private readonly inFlight = new Map<string, Promise<MarketQuote | null>>();

  constructor(private readonly options: TwelveDataQuoteClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Twelve Data quotes require an API key.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.twelvedata.com";
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
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
    const cached = this.cache.get(symbol);
    if (cached && this.now() - cached.fetchedAt < this.minRefreshIntervalMs) {
      return cached.quote;
    }
    const pending = this.inFlight.get(symbol);
    if (pending) return pending;

    const request = this.fetchFresh(symbol).finally(() => this.inFlight.delete(symbol));
    this.inFlight.set(symbol, request);
    return request;
  }

  private async fetchFresh(symbol: string): Promise<MarketQuote | null> {
    const previousQuote = this.cache.get(symbol)?.quote ?? null;
    // Every attempt below records `fetchedAt` -- success or failure -- so `minRefreshIntervalMs`
    // throttles retries uniformly. Recording it only on success (the original shape) meant a
    // sustained outage or a 429 never advanced the cache timestamp, so every poll during the
    // failure kept re-hitting the network with no backoff: the same credit budget this cache
    // exists to protect getting spent re-asking a question that just failed.
    const recordAttempt = (quote: MarketQuote | null): MarketQuote | null => {
      this.cache.set(symbol, { quote, fetchedAt: this.now() });
      return quote;
    };

    let providerSymbol: string;
    try {
      providerSymbol = resolveTwelveDataSymbol(symbol);
    } catch {
      return previousQuote;
    }
    const endpoint = new URL("/quote", this.baseUrl);
    endpoint.searchParams.set("symbol", providerSymbol);
    endpoint.searchParams.set("apikey", this.options.apiKey);

    let payload: TwelveDataQuoteResponse | undefined;
    try {
      const response = await this.fetch(endpoint);
      payload = await response.json().catch(() => undefined) as TwelveDataQuoteResponse | undefined;
      // A rate-limited or otherwise-failed refresh keeps serving the last good cached quote
      // (if any) rather than dropping the tile -- the same "stale beats blank" reasoning
      // `MarketWatchBroadcaster` already documents for its own poll failures. Only actually
      // absent (never-fetched) data resolves to null here.
      if (!response.ok || payload?.status === "error") {
        return recordAttempt(previousQuote);
      }
    } catch {
      return recordAttempt(previousQuote);
    }
    if (payload === undefined) return recordAttempt(previousQuote);

    const price = numberOrNull(payload.close);
    if (price === null || price <= 0) return recordAttempt(previousQuote);

    const observedAtEpoch = payload.last_quote_at ?? payload.timestamp;
    const quote: MarketQuote = {
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
    return recordAttempt(quote);
  }
}
