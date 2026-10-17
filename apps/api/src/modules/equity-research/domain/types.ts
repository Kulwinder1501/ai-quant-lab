export type EquityExchange = "NSE" | "BSE";

export type EquityOutcome = "OK" | "EMPTY" | "RATE_LIMITED" | "ERROR";

export type StockHealthStatus = "OK" | "DEGRADED" | "UNAVAILABLE" | "RATE_LIMITED";

export type StockViewState = "OK" | "STALE" | "NEVER_FETCHED" | "UNAVAILABLE" | "RATE_LIMITED" | "REBACKFILL_NEEDED";
export type EquityStockState = StockViewState;

export type PriceQuoteLabel = "DELAYED" | "LAST-TRADED" | "PREVIOUS-CLOSE";

export interface WatchlistStockRecord {
  id: string;
  exchange: EquityExchange;
  symbol: string;
  yahoo_symbol: string;
  display_name: string | null;
  currency: string;
  active: boolean;
  note: string | null;
  added_at: Date;
  removed_at: Date | null;
  rebackfill_needed: boolean;
  series_version: number;
}

export interface RawRecord {
  id: string;
  source: string;
  endpoint: string;
  symbol: string;
  requested_at: Date;
  http_status: number;
  body_sha256: string;
  body: unknown;
  outcome: EquityOutcome;
  warnings: string[];
}

export interface PriceBarRecord {
  id: string;
  stock_id: string;
  bar_date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number; // Raw close only; adjclose is NEVER stored
  volume: number;
  source: string;
  raw_record_id: string | null;
  first_seen_at: Date;
  series_version: number;
}

export interface PriceBarRevisionRecord {
  id: string;
  stock_id: string;
  bar_date: string;
  previous_values: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  new_values: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  seen_at: Date;
  raw_record_id: string | null;
}

export interface CorporateActionRecord {
  id: string;
  stock_id: string;
  ex_date: string; // YYYY-MM-DD
  kind: "DIVIDEND" | "SPLIT";
  value: number;
  source: string;
  raw_record_id: string | null;
  first_seen_at: Date;
}

export interface SecondaryFactRecord {
  id: string;
  stock_id: string;
  item: string;
  period_type: "ANNUAL" | "QUARTERLY";
  period_end: string; // YYYY-MM-DD
  value: number;
  currency: string;
  basis: string; // Defaults to 'UNKNOWN'
  raw_record_id: string | null;
  first_seen_at: Date;
}

export interface QuoteCacheRecord {
  stock_id: string;
  last_price: number;
  market_time: Date;
  fetched_at: Date;
  label: PriceQuoteLabel;
  latency_seconds: number | null;
}

export interface SourceHealthRecord {
  source: string;
  endpoint: string;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  status: StockHealthStatus;
  consecutive_failures: number;
  calls_today: number;
  budget_today: number;
  date_key: string;
}

export interface SourceCallLogRecord {
  id: string;
  time: Date;
  source: string;
  endpoint: string;
  status: number;
  duration_ms: number;
  error_message: string | null;
}

export interface WatchlistStockItem {
  id: string;
  symbol: string;
  exchange: EquityExchange;
  yahooSymbol: string;
  displayName: string;
  currency: string;
  active: boolean;
  note: string | null;
  addedAt: string;
  lastPrice: number | null;
  changePercent: number | null;
  asOf: string | null;
  label: PriceQuoteLabel | null;
  state: EquityStockState;
  stateReason: string | null;
  historyDepth: {
    firstBarDate: string | null;
    lastBarDate: string | null;
    totalBars: number;
  };
  hasDataGap: boolean;
  rebackfillNeeded: boolean;
  seriesVersion: number;
}

