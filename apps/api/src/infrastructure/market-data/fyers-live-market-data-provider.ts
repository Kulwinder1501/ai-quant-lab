import type { LiveMarketDataProvider, LiveMarketQuote } from "../../modules/market-data/domain/live-market-data-provider.js";
import { FYERS_PROVIDER_ID, type FyersTokenService } from "./fyers-token-service.js";

type FetchFunction = typeof fetch;

interface FyersQuoteData {
  n?: string;
  v?: {
    lp?: number;
    volume?: number | null;
    tt?: string | null;
  };
  s?: string;
}

interface FyersQuotePayload {
  s?: string;
  code?: number;
  message?: string;
  d?: FyersQuoteData[];
}

export interface FyersLiveMarketDataProviderOptions {
  tokenService: FyersTokenService;
  appId: string;
  fetch?: FetchFunction;
  baseUrl?: string;
}

const maxInstrumentsPerRequest = 50;

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

/**
 * `v.tt` is deliberately **not** read as an exchange timestamp.
 *
 * It reads as a last-traded time, and the obvious wiring is one line away, but measured
 * against the live endpoint on 2026-08-07 at 07:05 UTC it was `"1786060800"` --
 * 2026-08-07T00:00:00Z -- for an equity (SBIN, mid-session, 7,487,324 traded) and for an
 * index alike. It is the session date at UTC midnight, not a trade time.
 *
 * `CollectLiveMarketData` prefers `exchangeTimestamp` over `observedAt` when choosing which
 * candle window a quote belongs to, so populating it from `tt` would place every quote at
 * 05:30 IST, outside the session, and `applyQuote` would reject all of them: collection
 * would stop entirely and look like an empty market rather than a bug.
 *
 * So this stays null, and the poll clock is the timestamp. That is a real limitation --
 * poll latency near a window boundary can land a tick in the neighbouring minute -- and it
 * is the lesser of the two.
 */
const EXCHANGE_TIMESTAMP_UNAVAILABLE = null;

function decimal(value: number | null | undefined, field: string): string | null {
  // Absent stays absent. `LiveMarketQuote.cumulativeVolume` is "when provided", and the
  // collector reads a value -- including "0" -- as a real cumulative baseline it can
  // subtract from. Defaulting a missing volume to "0" therefore does not mean "no volume
  // seen": the next quote that does carry one produces a delta of the entire session's
  // traded volume, dumped into whichever bar happened to be open.
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Fyers quote contains invalid ${field}.`);
  }
  return String(value);
}

/** Read-only polling adapter for Fyers Data API v3 Quotes endpoint. */
export class FyersLiveMarketDataProvider implements LiveMarketDataProvider {
  readonly id = FYERS_PROVIDER_ID;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;

  constructor(private readonly options: FyersLiveMarketDataProviderOptions) {
    if (!options.appId.trim()) {
      throw new Error("Fyers live collection requires an app ID.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api-t1.fyers.in";
  }

  async fetchQuotes(providerInstrumentIds: string[]): Promise<LiveMarketQuote[]> {
    const distinctIds = [...new Set(providerInstrumentIds.filter((id) => id.trim().length > 0))];
    const allQuotes: LiveMarketQuote[] = [];
    
    // One token for the whole polling batch
    const accessToken = await this.options.tokenService.getAccessToken();

    for (const requestedIds of chunks(distinctIds, maxInstrumentsPerRequest)) {
      allQuotes.push(...await this.fetchBatch(requestedIds, accessToken));
    }
    return allQuotes;
  }

  private async fetchBatch(providerInstrumentIds: string[], accessToken: string): Promise<LiveMarketQuote[]> {
    const endpoint = new URL("/data/quotes", this.baseUrl);
    endpoint.searchParams.set("symbols", providerInstrumentIds.join(","));

    const response = await this.fetch(endpoint, {
      headers: {
        Authorization: `${this.options.appId}:${accessToken}`,
      },
    });
    
    const payload = await response.json().catch(() => undefined) as FyersQuotePayload | undefined;
    if (!response.ok || payload?.s !== "ok" || !Array.isArray(payload.d)) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(`Fyers quote request failed with HTTP ${response.status}.${detail}`);
    }

    const observedAt = new Date();
    
    // Create a map to quickly look up requested symbols, case-insensitively
    const requestedMap = new Map(providerInstrumentIds.map(id => [id.toUpperCase(), id]));

    return payload.d.flatMap((quoteData) => {
      if (quoteData.s !== "ok" || !quoteData.n || !quoteData.v) {
        return [];
      }

      const providerInstrumentId = requestedMap.get(quoteData.n.toUpperCase());
      if (!providerInstrumentId) {
        return [];
      }

      // One unusable row must not cost the other 49. `CollectLiveMarketData` rejects a
      // non-positive price by throwing, so a single bad symbol would otherwise abort the
      // whole poll; skipping leaves that instrument without a quote this tick, which the
      // collector already handles.
      const lastPrice = quoteData.v.lp;
      if (lastPrice === null || lastPrice === undefined || !Number.isFinite(lastPrice) || lastPrice <= 0) {
        return [];
      }

      return [{
        providerInstrumentId,
        lastPrice: String(lastPrice),
        cumulativeVolume: decimal(quoteData.v.volume, "volume"),
        observedAt,
        exchangeTimestamp: EXCHANGE_TIMESTAMP_UNAVAILABLE,
      }];
    });
  }
}
