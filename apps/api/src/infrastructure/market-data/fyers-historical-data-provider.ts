import type {
  HistoricalMarketCandle,
  HistoricalMarketDataProvider,
  HistoricalMarketDataRequest,
  HistoricalTimeframe,
} from "../../modules/market-data/domain/historical-data-provider.js";
import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";
import { FYERS_PROVIDER_ID } from "./fyers-token-service.js";

type FetchFunction = typeof fetch;
type FyersCandleTuple = [number, number, number, number, number, number];

interface FyersHistoryResponse {
  s?: string;
  code?: number;
  message?: string;
  candles?: FyersCandleTuple[];
}

export interface FyersAccessTokenSource {
  getAccessToken(): Promise<string>;
}

export interface FyersHistoricalDataProviderOptions {
  tokenService: FyersAccessTokenSource;
  appId: string;
  /** Injectable for deterministic tests. */
  fetch?: FetchFunction;
  baseUrl?: string;
  maxDaysPerRequest?: number;
  now?: () => Date;
  /** Injectable so tests do not actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** Every lab timeframe maps to a native Fyers resolution, so nothing is resampled. */
const fyersResolution: Record<HistoricalTimeframe, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "10m": "10",
  "15m": "15",
  "30m": "30",
  "60m": "60",
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
  // The NSE cash session is 09:15–15:30 IST. Matches the Kite adapter so a daily
  // candle means the same span whichever provider wrote it.
  "1d": 6 * 60 * 60_000 + 15 * 60_000,
};

/** Fyers allows 100 days per intraday request and 366 for daily. */
function maxDaysFor(timeframe: HistoricalTimeframe): number {
  return timeframe === "1d" ? 366 : 100;
}

function asDecimal(value: number, name: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Fyers returned an invalid ${name} value.`);
  }
  return String(value);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60_000);
}

/** Fyers expects `range_from`/`range_to` as yyyy-mm-dd with `date_format=1`. */
function formatRangeDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const IST_OFFSET_MS = 5.5 * 60 * 60_000;

/** Current NSE calendar date, expressed as a UTC date key for Fyers. */
function currentMarketDate(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
  ));
}

function nseSessionOpenFor(epochSeconds: number): Date {
  const ist = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
  return new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    3,
    45,
  ));
}

/**
 * Read-only adapter for Fyers API v3's historical endpoint. It never calls an order,
 * position, or funds endpoint.
 *
 * Owns the timeframes Yahoo cannot serve honestly (`1m`, `3m`, `5m`, `10m`). The
 * provenance split is by timeframe rather than by date so that no single series is
 * ever half Fyers and half Yahoo — a train/serve skew that would be invisible at the
 * data layer.
 */
export class FyersHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = FYERS_PROVIDER_ID;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly maxDaysOverride: number | null;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: FyersHistoricalDataProviderOptions) {
    if (!options.appId.trim()) {
      throw new Error("Fyers historical collection requires an app ID.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api-t1.fyers.in";
    this.maxDaysOverride = options.maxDaysPerRequest ?? null;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 5;
    if (this.maxDaysOverride !== null
      && (!Number.isInteger(this.maxDaysOverride) || this.maxDaysOverride < 1)) {
      throw new Error("Fyers maxDaysPerRequest must be a positive integer.");
    }
  }

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const symbol = resolveFyersSymbol(request.providerInstrumentId);
    const maxDays = this.maxDaysOverride ?? maxDaysFor(request.timeframe);

    // Fyers returns a partial candle for the interval in progress. Clamping to the
    // previous day keeps a provisional row out of every run; the importer would mark
    // it incomplete anyway, so this is hygiene rather than a correctness fix.
    const now = this.now();
    const currentMarketDay = currentMarketDate(now);
    const to = new Date(Math.min(request.to.getTime(), currentMarketDay.getTime()));
    if (to < request.from) {
      return [];
    }

    // One token for the whole campaign: resolved once, reused across every chunk.
    const accessToken = await this.options.tokenService.getAccessToken();

    const candles: HistoricalMarketCandle[] = [];
    let cursor = new Date(request.from);
    while (cursor <= to) {
      const chunkEnd = new Date(Math.min(addDays(cursor, maxDays - 1).getTime(), to.getTime()));
      candles.push(...await this.fetchChunk(request, symbol, accessToken, cursor, chunkEnd));
      cursor = addDays(chunkEnd, 1);
    }
    // Fyers can include the interval currently forming. Keep today's completed bars,
    // which the VIX scheduler needs, and discard only rows whose close is still ahead.
    return candles.filter((candle) => candle.closeTime.getTime() <= now.getTime());
  }

  private async fetchChunk(
    request: HistoricalMarketDataRequest,
    symbol: string,
    accessToken: string,
    from: Date,
    to: Date,
  ): Promise<HistoricalMarketCandle[]> {
    const endpoint = new URL("/data/history", this.baseUrl);
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("resolution", fyersResolution[request.timeframe]);
    endpoint.searchParams.set("date_format", "1");
    endpoint.searchParams.set("range_from", formatRangeDate(from));
    endpoint.searchParams.set("range_to", formatRangeDate(to));
    // cont_flag=0, always. Measured 2026-08-03 against the live endpoint:
    //
    //   NIFTY26AUGFUT, Jan 2026: cont_flag=0 → no data (the contract did not trade);
    //                            cont_flag=1 → 375 fabricated bars stitched from
    //                            earlier contracts under August's symbol.
    //   NIFTY26AUGFUT, Jul 2026: cont_flag=0 → firstClose 24305;
    //                            cont_flag=1 → firstClose 24208 (~0.4% lower).
    //
    // So cont_flag=1 both invents history and back-adjusts prices, by an undocumented
    // method. A back-adjusted price at time T embeds roll factors fixed after T, which
    // is look-ahead by construction, and rewriting prior bars is impossible anyway
    // because completed candles are immutable. A continuous series must therefore be
    // derived at feature-build time from raw per-contract bars, never fetched
    // pre-stitched. (Verified to make no difference for index symbols.)
    endpoint.searchParams.set("cont_flag", "0");

    // A multi-year 1m backfill is thousands of requests, and Fyers starts answering
    // 429 after a burst of roughly a dozen. Without backoff the campaign dies partway
    // and leaves a half-filled series that looks like a provider gap.
    let response: Response | undefined;
    let payload: FyersHistoryResponse | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.fetch(endpoint, {
          headers: { Authorization: `${this.options.appId}:${accessToken}` },
        });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Fyers history request for ${symbol} ${request.timeframe} failed after `
            + `${attempt + 1} network attempts: ${detail}`,
          );
        }
        await this.sleep(Math.min(2 ** attempt * 1000, 30_000));
        continue;
      }
      payload = await response.json().catch(() => undefined) as FyersHistoryResponse | undefined;
      const rateLimited = response.status === 429 || payload?.code === 429;
      const retryableServerFailure = response.status === 408 || response.status >= 500;
      if ((!rateLimited && !retryableServerFailure) || attempt >= this.maxRetries) break;
      // Honour Retry-After when Fyers sends it; otherwise exponential backoff.
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 30_000);
      await this.sleep(waitMs);
    }

    if (!response) throw new Error(`Fyers history request for ${symbol} returned no response.`);

    // Fyers signals failure in the body with HTTP 200, so `response.ok` alone is not
    // a verdict; `s` is the field that decides.
    if (!response.ok || payload?.s !== "ok" || !Array.isArray(payload.candles)) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(
        `Fyers history request for ${symbol} ${request.timeframe} `
        + `(${formatRangeDate(from)} → ${formatRangeDate(to)}) failed with HTTP ${response.status}, `
        + `code ${payload?.code ?? "none"}.${detail}`,
      );
    }

    return payload.candles.map((candle) => this.toCandle(candle, request.timeframe));
  }

  private toCandle(candle: FyersCandleTuple, timeframe: HistoricalTimeframe): HistoricalMarketCandle {
    const [epochSeconds, open, high, low, close, volume] = candle;
    if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
      throw new Error("Fyers returned a candle without a usable timestamp.");
    }
    // Epoch seconds, unlike Kite's offset-suffixed strings.
    const openTime = timeframe === "1d"
      ? nseSessionOpenFor(epochSeconds)
      : new Date(epochSeconds * 1000);
    return {
      openTime,
      closeTime: new Date(openTime.getTime() + timeframeDurationMs[timeframe]),
      open: asDecimal(open, "open"),
      high: asDecimal(high, "high"),
      low: asDecimal(low, "low"),
      close: asDecimal(close, "close"),
      volume: asDecimal(volume, "volume"),
    };
  }
}
