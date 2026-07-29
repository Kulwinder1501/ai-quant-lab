import type { LiveMarketDataProvider, LiveMarketQuote } from "../../modules/market-data/domain/live-market-data-provider.js";

type FetchFunction = typeof fetch;

interface KiteQuotePayload {
  status: string;
  data?: Record<string, {
    last_price?: number;
    volume?: number | null;
    timestamp?: string | null;
    last_trade_time?: string | null;
  }>;
  message?: string;
}

export interface KiteLiveMarketDataProviderOptions {
  apiKey: string;
  accessToken: string;
  fetch?: FetchFunction;
  baseUrl?: string;
}

const maxInstrumentsPerRequest = 500;

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function optionalTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function decimal(value: number | null | undefined, field: string, defaultValue: string | null = null): string | null {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Kite quote contains invalid ${field}.`);
  }
  return String(value);
}

/** Read-only polling adapter for Kite's documented full-quote endpoint. */
export class KiteLiveMarketDataProvider implements LiveMarketDataProvider {
  readonly id = "kite-connect-v3";
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;

  constructor(private readonly options: KiteLiveMarketDataProviderOptions) {
    if (!options.apiKey.trim() || !options.accessToken.trim()) {
      throw new Error("Kite live collection requires an API key and access token.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.kite.trade";
  }

  async fetchQuotes(providerInstrumentIds: string[]): Promise<LiveMarketQuote[]> {
    const distinctIds = [...new Set(providerInstrumentIds.filter((id) => id.trim().length > 0))];
    const allQuotes: LiveMarketQuote[] = [];
    for (const requestedIds of chunks(distinctIds, maxInstrumentsPerRequest)) {
      allQuotes.push(...await this.fetchBatch(requestedIds));
    }
    return allQuotes;
  }

  private async fetchBatch(providerInstrumentIds: string[]): Promise<LiveMarketQuote[]> {
    const endpoint = new URL("/quote", this.baseUrl);
    for (const providerInstrumentId of providerInstrumentIds) {
      endpoint.searchParams.append("i", providerInstrumentId);
    }

    const response = await this.fetch(endpoint, {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${this.options.apiKey}:${this.options.accessToken}`,
      },
    });
    const payload = await response.json().catch(() => undefined) as KiteQuotePayload | undefined;
    if (!response.ok || payload?.status !== "success" || !payload.data) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(`Kite quote request failed with HTTP ${response.status}.${detail}`);
    }

    const observedAt = new Date();
    return providerInstrumentIds.flatMap((providerInstrumentId) => {
      const quote = payload.data?.[providerInstrumentId];
      const price = decimal(quote?.last_price, "last price");
      if (!quote || !price || price === "0") {
        return [];
      }
      return [{
        providerInstrumentId,
        lastPrice: price,
        cumulativeVolume: decimal(quote.volume, "volume", "0"),
        observedAt,
        exchangeTimestamp: optionalTimestamp(quote.timestamp ?? quote.last_trade_time),
      }];
    });
  }
}
