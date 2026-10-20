import { getApiV1Url } from "../research/api";
import type {
  AlertRecord,
  AlertStatus,
  EquityExchange,
  EventFlagRecord,
  HistoryRange,
  LevelsPanelResponse,
  ManualEventKind,
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

export async function fetchStockLevels(
  id: string,
  signal?: AbortSignal,
): Promise<LevelsPanelResponse> {
  const url = `${getApiV1Url()}/equity/watchlist/${id}/levels`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch levels (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as LevelsPanelResponse;
}

export async function fetchEquityAlerts(
  filter?: {
    stockId?: string;
    symbol?: string;
    status?: AlertStatus;
    kind?: string;
    severity?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  },
  signal?: AbortSignal,
): Promise<AlertRecord[]> {
  const params = new URLSearchParams();
  if (filter?.stockId) params.set("stockId", filter.stockId);
  if (filter?.symbol) params.set("symbol", filter.symbol);
  if (filter?.status) params.set("status", filter.status);
  if (filter?.kind) params.set("kind", filter.kind);
  if (filter?.severity) params.set("severity", filter.severity);
  if (filter?.from) params.set("from", filter.from);
  if (filter?.to) params.set("to", filter.to);
  if (filter?.limit) params.set("limit", String(filter.limit));
  if (filter?.offset) params.set("offset", String(filter.offset));

  const qs = params.toString();
  const url = `${getApiV1Url()}/equity/alerts${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch alerts (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as AlertRecord[];
}

export async function updateAlertStatus(
  id: string,
  status: AlertStatus,
  signal?: AbortSignal,
): Promise<{ success: boolean; status: AlertStatus }> {
  const url = `${getApiV1Url()}/equity/alerts/${id}/state`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ status }),
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to update alert state (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as { success: boolean; status: AlertStatus };
}

export async function fetchEquityEvents(
  filter?: {
    stockId?: string;
    symbol?: string;
    origin?: string;
    kind?: string;
    from?: string;
    to?: string;
    includeHistory?: boolean;
    limit?: number;
    offset?: number;
  },
  signal?: AbortSignal,
): Promise<EventFlagRecord[]> {
  const params = new URLSearchParams();
  if (filter?.stockId) params.set("stockId", filter.stockId);
  if (filter?.symbol) params.set("symbol", filter.symbol);
  if (filter?.origin) params.set("origin", filter.origin);
  if (filter?.kind) params.set("kind", filter.kind);
  if (filter?.from) params.set("from", filter.from);
  if (filter?.to) params.set("to", filter.to);
  if (filter?.includeHistory) params.set("includeHistory", "true");
  if (filter?.limit) params.set("limit", String(filter.limit));
  if (filter?.offset) params.set("offset", String(filter.offset));

  const qs = params.toString();
  const url = `${getApiV1Url()}/equity/events${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to fetch events (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as EventFlagRecord[];
}

export async function createManualEvent(
  input: {
    stockId: string;
    kind: ManualEventKind;
    eventDate: string;
    headline: string;
    sourceUrl: string;
    detail?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<EventFlagRecord> {
  const url = `${getApiV1Url()}/equity/events`;
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
    let msg = `Failed to create event (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as EventFlagRecord;
}

export async function editManualEvent(
  id: string,
  input: {
    headline?: string;
    sourceUrl?: string;
    kind?: ManualEventKind;
    eventDate?: string;
    detail?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<EventFlagRecord> {
  const url = `${getApiV1Url()}/equity/events/${id}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    let msg = `Failed to edit event (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {}
    throw new EquityApiError(msg, res.status);
  }

  return (await res.json()) as EventFlagRecord;
}


