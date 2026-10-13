import type {
  HistoricalMarketCandle,
  HistoricalMarketDataProvider,
  HistoricalMarketDataRequest,
  HistoricalTimeframe,
} from "../../modules/market-data/domain/historical-data-provider.js";
import { resolveOandaSymbol } from "../../modules/market-data/domain/oanda-symbol-resolver.js";

export const OANDA_PROVIDER_ID = "oanda";

type FetchFunction = typeof fetch;

interface OandaCandleData {
  o: string;
  h: string;
  l: string;
  c: string;
}

interface OandaCandle {
  time: string;
  bid?: OandaCandleData;
  ask?: OandaCandleData;
  mid?: OandaCandleData;
  volume: number;
  complete: boolean;
}

interface OandaCandlesResponse {
  instrument?: string;
  granularity?: string;
  candles?: OandaCandle[];
  errorMessage?: string;
}

export interface OandaHistoricalDataProviderOptions {
  accessToken: string;
  environment?: "practice" | "trade";
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for a 429 or a dropped connection. */
  maxRetries?: number;
  /** Retries for the statuses in `TRANSIENT_STATUSES`. */
  maxTransientRetries?: number;
}

/**
 * Statuses OANDA returns for a request that is worth repeating, besides a 429.
 *
 * A 401 is in here although it normally means bad credentials. The practice endpoint refuses a valid token now and
 * then: over four days about 4% of the scheduled gold candle runs got a 401, while 120 consecutive requests with the
 * same token from the same container all succeeded, and each failed run was followed by a successful one. A token
 * that really is revoked still fails: every attempt gets the 401 and the error is thrown after the last retry.
 * 502/503/504 are the gateway errors OANDA's edge returns when its backend hiccups.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([401, 502, 503, 504]);
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const REFUSAL_BODY_LIMIT = 300;

const oandaInterval: Record<HistoricalTimeframe, string> = {
  "1m": "M1",
  "3m": "M3",
  "5m": "M5",
  "10m": "M10",
  "15m": "M15",
  "30m": "M30",
  "60m": "H1",
  "1d": "D",
};

const timeframeDurationMs: Record<HistoricalTimeframe, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * What OANDA said when it refused a request: its request id, and the start of the body.
 *
 * Read from a clone so the response the caller holds is still unread. The token is never in either place, but the
 * body is cut short anyway: an error page is not worth a log line of its own.
 */
async function describeRefusal(response: Response): Promise<{ requestId: string | null; body: string }> {
  let body = "";
  try {
    body = (await response.clone().text()).replace(/\s+/g, " ").trim().slice(0, REFUSAL_BODY_LIMIT);
  } catch {
    // An unreadable body is not worth failing the request over.
  }
  return { requestId: response.headers.get("x-request-id"), body };
}

export class OandaHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = OANDA_PROVIDER_ID;
  private readonly accessToken: string;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxTransientRetries: number;

  constructor(options: OandaHistoricalDataProviderOptions) {
    if (!options.accessToken) throw new Error("OandaHistoricalDataProvider requires an accessToken.");
    this.accessToken = options.accessToken;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    
    if (options.baseUrl) {
      this.baseUrl = options.baseUrl;
    } else {
      this.baseUrl = options.environment === "trade" 
        ? "https://api-fxtrade.oanda.com" 
        : "https://api-fxpractice.oanda.com";
    }
    
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  }

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const oandaSymbol = request.providerInstrumentId;
    const granularity = oandaInterval[request.timeframe];
    
    if (!granularity) {
      throw new Error(`Unsupported timeframe "${request.timeframe}" for OANDA.`);
    }

    const durationMs = timeframeDurationMs[request.timeframe];
    let currentStart = request.from.getTime();
    const endMs = request.to.getTime();
    const results: HistoricalMarketCandle[] = [];

    while (currentStart < endMs) {
      // OANDA allows max 5000 candles per request
      const chunkSize = 5000;
      const chunkEndMs = Math.min(currentStart + chunkSize * durationMs, endMs);
      
      const chunkStartStr = new Date(currentStart).toISOString();
      // subtract 1ms so we don't accidentally grab the next bar
      const chunkEndStr = new Date(chunkEndMs - 1).toISOString();

      const url = new URL(`/v3/instruments/${oandaSymbol}/candles`, this.baseUrl);
      url.searchParams.set("granularity", granularity);
      url.searchParams.set("price", "BAM"); // Bid, Ask, Mid prices
      url.searchParams.set("from", chunkStartStr);
      url.searchParams.set("to", chunkEndStr);
      url.searchParams.set("includeFirst", "true");

      console.log("Fetching", url.toString());
      const response = await this.fetchWithRetry(url);
      
      if (!response.ok) {
        if (response.status === 404 || response.status === 400) {
           break; // Bad symbol or range
        }
        // The prefix is what operators and job-history queries match on; what OANDA said follows it.
        const refusal = await describeRefusal(response);
        throw new Error(
          `OANDA candles failed: ${response.status} ${response.statusText}`
          + (refusal.requestId ? ` (request id ${refusal.requestId})` : "")
          + (refusal.body ? `: ${refusal.body}` : ""),
        );
      }

      const payload = (await response.json()) as OandaCandlesResponse;
      if (payload.errorMessage) {
        throw new Error(`OANDA error: ${payload.errorMessage}`);
      }

      const candles = payload.candles ?? [];
      if (candles.length === 0) {
        currentStart = chunkEndMs;
        continue;
      }

      for (const c of candles) {
        if (!c.mid) continue; // safety check
        const openTime = new Date(c.time).getTime();
        const closeTime = openTime + durationMs;

        // OANDA returns bars where openTime == request.from and may slightly overfetch 
        if (openTime >= endMs) continue;

        results.push({
          openTime: new Date(openTime),
          closeTime: new Date(closeTime),
          open: c.mid.o,
          high: c.mid.h,
          low: c.mid.l,
          close: c.mid.c,
          volume: c.volume.toString(), // Tick volume
          complete: c.complete,
          ...(c.bid ? { bid: { open: c.bid.o, high: c.bid.h, low: c.bid.l, close: c.bid.c } } : {}),
          ...(c.ask ? { ask: { open: c.ask.o, high: c.ask.h, low: c.ask.l, close: c.ask.c } } : {}),
        });
      }

      // Advance by the last candle's open time + 1 to avoid overlap, 
      // or by the chunk size if we got exactly 5000
      const lastCandle = candles[candles.length - 1];
      const lastOpenTime = new Date(lastCandle.time).getTime();
      
      if (lastOpenTime >= currentStart) {
         currentStart = lastOpenTime + durationMs;
      } else {
         // Fallback if data is sparse or weird
         currentStart = chunkEndMs;
      }
    }

    return results;
  }

  private async fetchWithRetry(url: URL): Promise<Response> {
    // Counted separately: a rate limit, a refused request and a dropped connection are different failures with
    // different budgets, and sharing one counter would let a burst of one use up the retries meant for another.
    let rateLimitRetries = 0;
    let transientRetries = 0;
    let networkRetries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Accept-Datetime-Format": "RFC3339",
          },
        });
      } catch (err) {
        if (networkRetries >= this.maxRetries) throw err;
        await this.sleep(1000 * Math.pow(2, networkRetries));
        networkRetries += 1;
        continue;
      }

      if (response.status === 429 && rateLimitRetries < this.maxRetries) {
        await this.sleep(1000 * Math.pow(2, rateLimitRetries)); // Exp backoff
        rateLimitRetries += 1;
        continue;
      }

      if (!response.ok && TRANSIENT_STATUSES.has(response.status)) {
        const willRetry = transientRetries < this.maxTransientRetries;
        // Logged whether or not it is retried: until now the body and request id were thrown away, so a refusal
        // could never be explained after the fact.
        const refusal = await describeRefusal(response);
        console.warn(JSON.stringify({
          level: "warn",
          message: willRetry ? "OANDA refused a request; retrying" : "OANDA refused a request; giving up",
          source: "OandaHistoricalDataProvider",
          path: url.pathname,
          status: response.status,
          requestId: refusal.requestId,
          body: refusal.body,
          attempt: transientRetries + 1,
          maxAttempts: this.maxTransientRetries + 1,
        }));
        if (willRetry) {
          await this.sleep(1000 * Math.pow(2, transientRetries));
          transientRetries += 1;
          continue;
        }
      }
      return response;
    }
  }
}
