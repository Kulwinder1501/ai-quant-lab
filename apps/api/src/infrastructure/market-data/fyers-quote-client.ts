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

/**
 * Ceiling on any single backoff sleep between quote attempts.
 *
 * Fyers rate-limits at its Cloudflare edge and answers 429 with a `retry-after` measured in
 * tens of minutes -- 2374 seconds, observed 2026-08-27. Honouring that literally let one quote
 * call block for up to `maxRetries` sleeps of 39.6 minutes *inside an HTTP handler*, which is how
 * a 40-minute provider penalty became a multi-hour outage: the market-watch SSE stream guards its
 * poll with `pollInFlight`, so the sleeping call silently suppressed every later tick on that
 * connection and the UI sat on "connecting" with nothing logged.
 *
 * A penalty that long is not something a request can wait out. The caller has to fail and let the
 * next poll try. Note the exponential fallback below was always capped -- only the header-derived
 * path was unbounded, so this restores the bound the code already assumed everywhere else.
 */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Ceiling on one quote round-trip.
 *
 * The provider answers a 429 in ~150ms, so this is not for the slow case -- it is for the case
 * where no response ever arrives. Nothing here bounded that, and an unbounded fetch inside a
 * stream poll is indistinguishable from a wedged stream.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface FyersQuoteClientOptions {
  tokenService: { getAccessToken(): Promise<string> };
  appId: string;
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetryDelayMs?: number;
  requestTimeoutMs?: number;
}

/** Canonical-symbol quote reader backed only by the Fyers Quotes API with retry on 429 rate limits. */
export class FyersQuoteClient implements MarketQuoteReader {
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: FyersQuoteClientOptions) {
    if (!options.appId.trim()) throw new Error("Fyers quotes require an app ID.");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api-t1.fyers.in";
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
      let retryAfterSeconds: number | null = null;

      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await this.fetch(endpoint, {
            headers: { Authorization: `${this.options.appId}:${accessToken}` },
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (error) {
          if (attempt >= this.maxRetries) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Fyers quote request failed after ${attempt + 1} network attempts: ${detail}`);
          }
          await this.sleep(Math.min(2 ** attempt * 500, this.maxRetryDelayMs));
          continue;
        }

        payload = await response.json().catch(() => undefined) as FyersQuotePayload | undefined;
        const rateLimited = response.status === 429 || payload?.code === 429;
        const retryableServerFailure = response.status === 408 || response.status >= 500;

        /*
         * Read before the `break` below, not after.
         *
         * The cooldown has to be captured on every rate-limited response, including the one that
         * exhausts the retries -- which is exactly when an operator needs it, and exactly the path
         * that skips everything after the break.
         */
        const retryAfter = Number(response.headers.get("retry-after"));
        if (rateLimited && Number.isFinite(retryAfter) && retryAfter > 0) {
          retryAfterSeconds = retryAfter;
        }

        if ((!rateLimited && !retryableServerFailure) || attempt >= this.maxRetries) break;

        // Capped deliberately: see MAX_RETRY_DELAY_MS. A multi-minute `retry-after` is a signal to
        // give up on this call, not an instruction to sleep through it holding a request open.
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, this.maxRetryDelayMs)
          : Math.min(2 ** attempt * 500, this.maxRetryDelayMs);
        await this.sleep(waitMs);
      }

      if (!response || !response.ok || payload?.s !== "ok" || !Array.isArray(payload.d)) {
        // `retry-after` is named explicitly because it is the one field that distinguishes "we are
        // briefly over the limit" from "this app is penalised for the next 40 minutes", and the
        // caller cannot see the response.
        const rateLimitDetail = retryAfterSeconds === null
          ? ""
          : ` Provider asked for a ${retryAfterSeconds}s cooldown (not waited out; capped at ${this.maxRetryDelayMs}ms per attempt).`;
        throw new Error(
          `Fyers quote request failed with HTTP ${response?.status ?? "none"}, code ${payload?.code ?? "none"}. `
          + `${payload?.message ?? "No quote rows returned."}${rateLimitDetail}`,
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
