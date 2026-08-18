import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";
import { FYERS_PROVIDER_ID } from "./fyers-token-service.js";

type FetchFunction = typeof fetch;

interface RawFyersQuote {
  n?: string;
  s?: string;
  v?: {
    lp?: number;
    ch?: number;
    chp?: number;
    open_price?: number;
    high_price?: number;
    low_price?: number;
    prev_close_price?: number;
    volume?: number | null;
  };
}

interface FyersQuotePayload {
  s?: string;
  code?: number;
  message?: string;
  d?: RawFyersQuote[];
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FyersQuoteClientOptions {
  tokenService: { getAccessToken(): Promise<string> };
  appId: string;
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Canonical-symbol quote reader backed only by the Fyers Quotes API with retry on 429 rate limits. */
export class FyersQuoteClient implements MarketQuoteReader {
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: FyersQuoteClientOptions) {
    if (!options.appId.trim()) throw new Error("Fyers quotes require an app ID.");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api-t1.fyers.in";
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const canonical = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
    const result = new Map<string, MarketQuote>();
    if (canonical.length === 0) return result;

    const providerToCanonical = new Map(
      canonical.map((symbol) => [resolveFyersSymbol(symbol).toUpperCase(), symbol]),
    );
    const providerSymbols = [...providerToCanonical.keys()];
    const accessToken = await this.options.tokenService.getAccessToken();

    for (let offset = 0; offset < providerSymbols.length; offset += 50) {
      const batch = providerSymbols.slice(offset, offset + 50);
      const endpoint = new URL("/data/quotes", this.baseUrl);
      endpoint.searchParams.set("symbols", batch.join(","));

      let response: Response | undefined;
      let payload: FyersQuotePayload | undefined;

      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await this.fetch(endpoint, {
            headers: { Authorization: `${this.options.appId}:${accessToken}` },
          });
        } catch (error) {
          if (attempt >= this.maxRetries) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Fyers quote request failed after ${attempt + 1} network attempts: ${detail}`);
          }
          await this.sleep(Math.min(2 ** attempt * 500, 10_000));
          continue;
        }

        payload = await response.json().catch(() => undefined) as FyersQuotePayload | undefined;
        const rateLimited = response.status === 429 || payload?.code === 429;
        const retryableServerFailure = response.status === 408 || response.status >= 500;
        if ((!rateLimited && !retryableServerFailure) || attempt >= this.maxRetries) break;

        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 10_000);
        await this.sleep(waitMs);
      }

      if (!response || !response.ok || payload?.s !== "ok" || !Array.isArray(payload.d)) {
        throw new Error(
          `Fyers quote request failed with HTTP ${response?.status ?? "none"}, code ${payload?.code ?? "none"}. `
          + `${payload?.message ?? "No quote rows returned."}`,
        );
      }

      const observedAt = (this.options.now ?? (() => new Date()))();
      for (const row of payload.d) {
        if (row.s !== "ok" || !row.n || !row.v) continue;
        const symbol = providerToCanonical.get(row.n.toUpperCase());
        const price = finiteOrNull(row.v.lp);
        if (!symbol || price === null || price <= 0) continue;
        result.set(symbol, {
          symbol,
          provider: FYERS_PROVIDER_ID,
          shortName: symbol,
          exchange: row.n.split(":", 1)[0] ?? "NSE",
          regularMarketPrice: price,
          regularMarketPreviousClose: finiteOrNull(row.v.prev_close_price),
          regularMarketChange: finiteOrNull(row.v.ch),
          regularMarketChangePercent: finiteOrNull(row.v.chp),
          regularMarketOpen: finiteOrNull(row.v.open_price),
          regularMarketDayHigh: finiteOrNull(row.v.high_price),
          regularMarketDayLow: finiteOrNull(row.v.low_price),
          regularMarketVolume: finiteOrNull(row.v.volume),
          // FYERS `tt` is the session date at UTC midnight, not a last-trade timestamp.
          regularMarketTime: observedAt,
        });
      }
    }
    return result;
  }
}
