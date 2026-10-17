import { getApiV1Url } from "../research/api";
import type {
  EquityExchange,
  HistoryRange,
  SourceHealthResponse,
  StockDetailResponse,
  TrendPanelResponse,
  WatchlistResponse,
  WatchlistStockItem,
} from "./types";

export class EquityApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EquityApiError";
  }
}

export async function fetchEquityWatchlist(signal?: AbortSignal): Promise<WatchlistResponse> {
  const url = `${getApiV1Url()}/equity/watchlist`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch watchlist (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as WatchlistResponse;
}

export async function addStockToWatchlist(
  input: { symbol: string; exchange: EquityExchange; note?: string },
  signal?: AbortSignal,
): Promise<WatchlistStockItem> {
  const url = `${getApiV1Url()}/equity/watchlist`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to add stock (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as WatchlistStockItem;
}

export async function removeStockFromWatchlist(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string }> {
  const url = `${getApiV1Url()}/equity/watchlist/${id}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to remove stock (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as { success: boolean; message: string };
}

export async function fetchStockDetail(
  id: string,
  range: HistoryRange = "1y",
  signal?: AbortSignal,
): Promise<StockDetailResponse> {
  const url = `${getApiV1Url()}/equity/watchlist/${id}/detail?range=${range}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch stock detail (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as StockDetailResponse;
}

export async function fetchSourceHealth(signal?: AbortSignal): Promise<SourceHealthResponse> {
  const url = `${getApiV1Url()}/equity/source-health`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch source health (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as SourceHealthResponse;
}

export async function fetchStockTrend(
  id: string,
  signal?: AbortSignal,
): Promise<TrendPanelResponse> {
  const url = `${getApiV1Url()}/equity/watchlist/${id}/trend`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch trend panel (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as TrendPanelResponse;
}

