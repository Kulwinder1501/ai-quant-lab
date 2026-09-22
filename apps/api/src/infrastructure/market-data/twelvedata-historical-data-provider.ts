import type {
  HistoricalMarketCandle,
  HistoricalMarketDataProvider,
  HistoricalMarketDataRequest,
  HistoricalTimeframe,
} from "../../modules/market-data/domain/historical-data-provider.js";
import { resolveTwelveDataSymbol } from "../../modules/market-data/domain/twelvedata-symbol-resolver.js";

export const TWELVEDATA_PROVIDER_ID = "twelvedata";

type FetchFunction = typeof fetch;

interface TwelveDataValue {
  datetime?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}

interface TwelveDataTimeSeriesResponse {
  status?: string;
  code?: number;
  message?: string;
  values?: TwelveDataValue[];
}

export interface TwelveDataHistoricalDataProviderOptions {
  apiKey: string;
  /** Injectable for deterministic tests. */
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
  /** Injectable so tests do not actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** Timeframes Twelve Data's `/time_series` endpoint natively serves. `3m`/`10m` have no native
 * interval on this provider and are deliberately unsupported here rather than resampled --
 * resampling would be new, untested aggregation logic, not a data-source swap. */
const twelveDataInterval: Partial<Record<HistoricalTimeframe, string>> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "60m": "1h",
  "1d": "1day",
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
 * Rows per request are capped at 5000 by Twelve Data's free tier. XAU/USD trades close to
 * continuously (Sun 22:00 UTC → Fri 22:00 UTC), so unlike an NSE session-bound instrument this
 * is a simple "rows = minutes-equivalent in the window" budget, not a trading-calendar one.
 * Chosen conservatively (well under 5000) to leave headroom for the actual weekend gaps.
 */
function maxMsPerRequest(timeframe: HistoricalTimeframe): number {
  const barMs = timeframeDurationMs[timeframe];
  const budgetRows = 4000;
  return barMs * budgetRows;
}

function toDecimal(value: string | undefined, name: string): string {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Twelve Data returned an invalid ${name} value.`);
  }
  return String(parsed);
}

/** Twelve Data expects `YYYY-MM-DD HH:MM:SS`. Always requested in UTC via `timezone=UTC`, so this
 * never has to guess an exchange-local offset the way a naive local-time format would. */
function formatDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Read-only adapter for Twelve Data's `/time_series` endpoint. It never calls an order,
 * position, or funds endpoint -- Twelve Data does not expose one; it is a pure data vendor.
 *
 * Exists because neither Fyers nor Kite (both India-only brokers) nor Yahoo's quote-snapshot
 * client can serve a real intraday candle series for a globally-quoted instrument like
 * `XAU_USD`. See `apps/api/src/modules/market-data/domain/twelvedata-symbol-resolver.ts` for
 * the canonical-symbol mapping.
 */
export class TwelveDataHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = TWELVEDATA_PROVIDER_ID;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: TwelveDataHistoricalDataProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Twelve Data historical collection requires an API key.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.twelvedata.com";
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 5;
  }

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const interval = twelveDataInterval[request.timeframe];
    if (interval === undefined) {
      throw new Error(
        `Twelve Data has no native interval for timeframe "${request.timeframe}". `
        + `Supported: ${Object.keys(twelveDataInterval).join(", ")}.`,
      );
    }
    const symbol = resolveTwelveDataSymbol(request.providerInstrumentId);

    const now = this.now();
    const to = new Date(Math.min(request.to.getTime(), now.getTime()));
    if (to < request.from) {
      return [];
    }

    const chunkMs = maxMsPerRequest(request.timeframe);
    const candles: HistoricalMarketCandle[] = [];
    let cursor = new Date(request.from);
    while (cursor <= to) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, to.getTime()));
      candles.push(...await this.fetchChunk(request.timeframe, interval, symbol, cursor, chunkEnd));
      cursor = new Date(chunkEnd.getTime() + timeframeDurationMs[request.timeframe]);
    }

    candles.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
    // A partially-formed "current" bar is possible on the free tier same as any live feed;
    // keep only bars whose close has actually elapsed.
    return candles.filter((candle) => candle.closeTime.getTime() <= now.getTime());
  }

  private async fetchChunk(
    timeframe: HistoricalTimeframe,
    interval: string,
    symbol: string,
    from: Date,
    to: Date,
  ): Promise<HistoricalMarketCandle[]> {
    const endpoint = new URL("/time_series", this.baseUrl);
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("interval", interval);
    endpoint.searchParams.set("start_date", formatDateTime(from));
    endpoint.searchParams.set("end_date", formatDateTime(to));
    endpoint.searchParams.set("timezone", "UTC");
    endpoint.searchParams.set("outputsize", "5000");
    endpoint.searchParams.set("apikey", this.options.apiKey);

    let response: Response | undefined;
    let payload: TwelveDataTimeSeriesResponse | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.fetch(endpoint);
      } catch (error) {
        if (attempt >= this.maxRetries) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Twelve Data history request for ${symbol} ${timeframe} failed after `
            + `${attempt + 1} network attempts: ${detail}`,
          );
        }
        await this.sleep(Math.min(2 ** attempt * 1000, 30_000));
        continue;
      }
      payload = await response.json().catch(() => undefined) as TwelveDataTimeSeriesResponse | undefined;
      // Twelve Data signals a rate limit with HTTP 429 or a 200 carrying status:"error"
      // and code 429 in the body -- checked the same defensive way the Fyers adapter does.
      const rateLimited = response.status === 429 || payload?.code === 429;
      const retryableServerFailure = response.status === 408 || response.status >= 500;
      if ((!rateLimited && !retryableServerFailure) || attempt >= this.maxRetries) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 30_000);
      await this.sleep(waitMs);
    }

    if (!response) throw new Error(`Twelve Data history request for ${symbol} returned no response.`);

    if (!response.ok || payload?.status !== "ok" || !Array.isArray(payload.values)) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(
        `Twelve Data history request for ${symbol} ${timeframe} `
        + `(${formatDateTime(from)} → ${formatDateTime(to)}) failed with HTTP ${response.status}, `
        + `status ${payload?.status ?? "none"}.${detail}`,
      );
    }

    return payload.values.map((value) => this.toCandle(value, timeframe));
  }

  private toCandle(value: TwelveDataValue, timeframe: HistoricalTimeframe): HistoricalMarketCandle {
    if (!value.datetime) {
      throw new Error("Twelve Data returned a candle without a usable timestamp.");
    }
    // Requested with timezone=UTC, so this is an unambiguous UTC wall-clock string.
    const openTime = new Date(`${value.datetime.replace(" ", "T")}Z`);
    if (Number.isNaN(openTime.getTime())) {
      throw new Error(`Twelve Data returned an unparseable timestamp: "${value.datetime}".`);
    }
    return {
      openTime,
      closeTime: new Date(openTime.getTime() + timeframeDurationMs[timeframe]),
      open: toDecimal(value.open, "open"),
      high: toDecimal(value.high, "high"),
      low: toDecimal(value.low, "low"),
      close: toDecimal(value.close, "close"),
      // Twelve Data's forex/metals feed does not carry real traded volume (there is no single
      // consolidated tape for an OTC-style instrument); it returns 0 rather than omitting the
      // field, so this is honoured as-is rather than defaulted to some other sentinel.
      volume: toDecimal(value.volume ?? "0", "volume"),
    };
  }
}
