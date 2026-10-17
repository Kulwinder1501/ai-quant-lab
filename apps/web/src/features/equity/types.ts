export type EquityExchange = "NSE" | "BSE";

export type PriceQuoteLabel = "PREVIOUS-CLOSE" | "DELAYED" | "LAST-TRADED";

export type EquityStockState = "OK" | "STALE" | "NEVER_FETCHED" | "UNAVAILABLE" | "RATE_LIMITED" | "REBACKFILL_NEEDED";

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
  rebackfillNeeded?: boolean;
  seriesVersion?: number;
}

export interface WatchlistResponse {
  stocks: WatchlistStockItem[];
  totalCount: number;
  sourceStatus: string;
}

export interface PriceBar {
  barDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CorporateAction {
  id: string;
  actionType: "DIVIDEND" | "SPLIT";
  actionDate: string;
  value: number;
  remarks: string | null;
}

export interface SecondaryFact {
  item: string;
  periodType: string;
  periodEnd: string;
  value: number;
  currency: string;
  basis: string;
  firstSeenAt: string;
}

export interface PriceBarRevision {
  barDate: string;
  previousValues: Record<string, number>;
  newValues: Record<string, number>;
  seenAt: string;
}

export interface CollectionLog {
  id: string;
  endpoint: string;
  symbol: string;
  requestedAt: string;
  httpStatus: number;
  outcome: string;
  warnings: string[];
}

export interface StockDetailResponse {
  stock: {
    id: string;
    symbol: string;
    exchange: EquityExchange;
    yahooSymbol: string;
    displayName: string;
    currency: string;
    active: boolean;
    note: string | null;
    addedAt: string;
  };
  quote: {
    lastPrice: number;
    marketTime: string;
    label: PriceQuoteLabel;
    latencySeconds: number;
    fetchedAt: string;
  } | null;
  priceBars: PriceBar[];
  summary: {
    firstBarDate: string | null;
    lastBarDate: string | null;
    totalBars: number;
    previousClose: number | null;
    latestClose: number | null;
    hasDataGap: boolean;
  };
  corporateActions: CorporateAction[];
  secondaryFundamentals: {
    heading: string;
    note: string;
    basisNotice: string;
    facts: SecondaryFact[];
  };
  revisions: PriceBarRevision[];
  collectionLogs: CollectionLog[];
}

export interface SourceHealthItem {
  source: string;
  endpoint: string;
  status: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  updatedAt: string;
}

export interface SourceHealthResponse {
  sources: SourceHealthItem[];
  recentCallLogs: CollectionLog[];
}

export type HistoryRange = "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";
