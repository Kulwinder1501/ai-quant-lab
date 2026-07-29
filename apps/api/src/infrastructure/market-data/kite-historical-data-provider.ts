import type { HistoricalMarketCandle, HistoricalMarketDataProvider, HistoricalMarketDataRequest, HistoricalTimeframe } from "../../modules/market-data/domain/historical-data-provider.js";

type FetchFunction = typeof fetch;
type KiteCandleTuple = [string, number, number, number, number, number | null, ...unknown[]];

interface KiteHistoricalResponse {
  status: string;
  data?: { candles?: KiteCandleTuple[] };
  message?: string;
}

export interface KiteHistoricalDataProviderOptions {
  apiKey: string;
  accessToken: string;
  /** Injectable for deterministic tests. */
  fetch?: FetchFunction;
  baseUrl?: string;
  maxDaysPerRequest?: number;
}

const kiteInterval: Record<HistoricalTimeframe, string> = {
  "1m": "minute",
  "3m": "3minute",
  "5m": "5minute",
  "10m": "10minute",
  "15m": "15minute",
  "30m": "30minute",
  "60m": "60minute",
  "1d": "day",
};

/**
 * Kite caps how much history one request may span, and the cap depends on the
 * interval: a year of daily candles is a single call, a year of minute candles is not.
 * Exceeding a cap is rejected outright rather than silently truncated, so a single
 * limit for every timeframe cannot be correct. Verify these against the current Kite
 * Connect documentation before widening them; `maxDaysPerRequest` overrides them all.
 */
const maxDaysPerRequestByTimeframe: Record<HistoricalTimeframe, number> = {
  "1m": 60,
  "3m": 100,
  "5m": 100,
  "10m": 100,
  "15m": 200,
  "30m": 200,
  "60m": 400,
  "1d": 2000,
};

const timeframeDurationMs: Record<HistoricalTimeframe, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
  "1d": 6 * 60 * 60_000 + 15 * 60_000,
};

function asDecimal(value: number | null, name: string, allowMissing = false): string {
  if (value === null) {
    if (allowMissing) {
      return "0";
    }
    throw new Error(`Kite returned missing ${name} value.`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Kite returned invalid ${name} value.`);
  }
  return String(value);
}

function normalizeKiteTimestamp(value: string): Date {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Kite returned invalid candle timestamp "${value}".`);
  }
  return timestamp;
}

function nseDailyOpen(value: string): Date {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!date) {
    throw new Error(`Kite returned a daily candle without a calendar date: "${value}".`);
  }
  // IST is UTC+05:30 and does not observe daylight-saving time.
  return new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 3, 45));
}

function formatKiteDateTime(value: Date): string {
  const ist = new Date(value.getTime() + 5.5 * 60 * 60_000);
  return ist.toISOString().replace("T", " ").slice(0, 19);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60_000);
}

/**
 * Read-only adapter for Kite Connect v3's historical-candle endpoint.
 * It never calls an order, portfolio, or broker-execution endpoint.
 */
export class KiteHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = "kite-connect-v3";
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly maxDaysPerRequestOverride: number | null;

  constructor(private readonly options: KiteHistoricalDataProviderOptions) {
    if (!options.apiKey.trim() || !options.accessToken.trim()) {
      throw new Error("Kite historical collection requires an API key and access token.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.kite.trade";
    this.maxDaysPerRequestOverride = options.maxDaysPerRequest ?? null;
    if (this.maxDaysPerRequestOverride !== null
      && (!Number.isInteger(this.maxDaysPerRequestOverride) || this.maxDaysPerRequestOverride < 1)) {
      throw new Error("Kite maxDaysPerRequest must be a positive integer.");
    }
  }

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const maxDaysPerRequest = this.maxDaysPerRequestOverride ?? maxDaysPerRequestByTimeframe[request.timeframe];
    const chunks: HistoricalMarketCandle[] = [];
    let cursor = new Date(request.from);

    while (cursor <= request.to) {
      const chunkEnd = new Date(Math.min(addDays(cursor, maxDaysPerRequest - 1).getTime(), request.to.getTime()));
      chunks.push(...await this.fetchChunk(request, cursor, chunkEnd));
      cursor = new Date(chunkEnd.getTime() + 1_000);
    }

    return chunks;
  }

  private async fetchChunk(
    request: HistoricalMarketDataRequest,
    from: Date,
    to: Date,
  ): Promise<HistoricalMarketCandle[]> {
    const endpoint = new URL(`/instruments/historical/${encodeURIComponent(request.providerInstrumentId)}/${kiteInterval[request.timeframe]}`, this.baseUrl);
    endpoint.searchParams.set("from", formatKiteDateTime(from));
    endpoint.searchParams.set("to", formatKiteDateTime(to));

    const response = await this.fetch(endpoint, {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${this.options.apiKey}:${this.options.accessToken}`,
      },
    });
    const payload = await response.json().catch(() => undefined) as KiteHistoricalResponse | undefined;
    if (!response.ok || payload?.status !== "success" || !Array.isArray(payload.data?.candles)) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(`Kite historical request failed with HTTP ${response.status}.${detail}`);
    }

    return payload.data.candles.map((candle) => this.toCandle(candle, request.timeframe));
  }

  private toCandle(candle: KiteCandleTuple, timeframe: HistoricalTimeframe): HistoricalMarketCandle {
    const [timestamp, open, high, low, close, volume] = candle;
    const openTime = timeframe === "1d" ? nseDailyOpen(timestamp) : normalizeKiteTimestamp(timestamp);
    return {
      openTime,
      closeTime: new Date(openTime.getTime() + timeframeDurationMs[timeframe]),
      open: asDecimal(open, "open"),
      high: asDecimal(high, "high"),
      low: asDecimal(low, "low"),
      close: asDecimal(close, "close"),
      volume: asDecimal(volume, "volume", true),
    };
  }
}
