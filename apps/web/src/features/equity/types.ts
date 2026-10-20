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
  trendSummary?: TrendSummaryItem;
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

export type TrendMetricState = "OK" | "INSUFFICIENT_HISTORY" | "NOT_MEANINGFUL" | "SUSPENDED";

export interface TrendMetricValue {
  formulaId: string;
  formulaText: string;
  window: string;
  value: number | null;
  formatted: string;
  barsUsed: number;
  firstDateUsed: string | null;
  lastDateUsed: string | null;
  state: TrendMetricState;
  warnings: string[];
}

export interface LargeDailyMove {
  date: string;
  previousClose: number;
  close: number;
  percentChange: number;
}

export interface TrendSummaryItem {
  return1M: number | null;
  return1Y: number | null;
  position52W: number | null;
  state: TrendMetricState;
  asOfDate?: string | null;
  isStale?: boolean;
}

export interface TrendPanelResponse {
  stock: {
    id: string;
    symbol: string;
    exchange: EquityExchange;
    yahooSymbol: string;
    displayName: string;
    active: boolean;
    seriesVersion: number;
    rebackfillNeeded: boolean;
  };
  asOfDate: string | null;
  isStale: boolean;
  staleDays: number;
  rebackfillNeeded: boolean;
  seriesVersion: number;
  metrics: {
    latestClose: TrendMetricValue;
    return1M: TrendMetricValue;
    return3M: TrendMetricValue;
    return6M: TrendMetricValue;
    returnYTD: TrendMetricValue;
    return1Y: TrendMetricValue;
    sma50: TrendMetricValue;
    sma200: TrendMetricValue;
    distanceFromSma50: TrendMetricValue;
    distanceFromSma200: TrendMetricValue;
    sma50VsSma200: TrendMetricValue;
    high52W: TrendMetricValue;
    low52W: TrendMetricValue;
    position52W: TrendMetricValue;
    distanceFrom52WHigh: TrendMetricValue;
    volatility20D: TrendMetricValue;
    volatility1Y: TrendMetricValue;
    maxDrawdown1Y: TrendMetricValue;
    relativeActivity: TrendMetricValue;
    largeDailyMovesCount: TrendMetricValue;
  };
  largeDailyMoves: LargeDailyMove[];
  trendSummary: TrendSummaryItem;
  disclaimer: string;
  warnings: string[];
}

export type LevelState = "INTACT" | "BROKEN" | "FLIPPED";
export type LevelSide = "SUPPORT" | "RESISTANCE";
export type LevelKind =
  | "SWING"
  | "52W_HIGH"
  | "52W_LOW"
  | "SMA_50"
  | "SMA_200"
  | "ROUND_NUMBER"
  | "GAP"
  | "VOLUME_PROFILE_POC"
  | "VOLUME_PROFILE_VAH"
  | "VOLUME_PROFILE_VAL";

export interface LevelItem {
  id: string;
  price: number;
  kind: LevelKind;
  source: string;
  side: LevelSide;
  touches: number;
  strength: number;
  firstDate: string;
  lastDate: string;
  distancePct: number;
  distanceAtr: number;
  zoneLow: number;
  zoneHigh: number;
  state: LevelState;
  brokenOn: string | null;
  volume?: number;
}

export type LevelsState = "OK" | "INSUFFICIENT_HISTORY" | "SUSPENDED" | "NOT_MEANINGFUL";

export interface LevelsPanelResponse {
  stock: {
    id: string;
    symbol: string;
    exchange: EquityExchange;
    yahooSymbol: string;
    displayName: string;
    active: boolean;
    seriesVersion: number;
    rebackfillNeeded: boolean;
  };
  asOfDate: string | null;
  isStale: boolean;
  staleDays: number;
  rebackfillNeeded: boolean;
  seriesVersion: number;
  state: LevelsState;
  atr14: number | null;
  atrPercent: number | null;
  levels: LevelItem[];
  nearestSupport: LevelItem | null;
  nearestResistance: LevelItem | null;
  riskDistanceAtr: number | null;
  warnings: string[];
  disclaimer: string;
  empiricalNote: string;
  formulas: Record<string, string>;
}

export type AlertStatus = "NEW" | "SEEN" | "DISMISSED";

export type AlertSeverity = "INFO" | "NOTICE";

export type AlertKind =
  | "LEVEL_APPROACH"
  | "LEVEL_ZONE_ENTER"
  | "LEVEL_BREAK"
  | "NEW_52W_EXTREME"
  | "LARGE_MOVE"
  | "DATA_EVENT"
  | "DATA_HEALTH";

export interface AlertRecord {
  id: string;
  stock_id: string;
  kind: AlertKind;
  level_key: string | null;
  evaluated_date: string;
  severity: AlertSeverity;
  title: string;
  payload_json: {
    close?: number | null;
    level?: number;
    atr?: number;
    seriesVersion?: number;
    rulesHash?: string;
    disclaimer?: string;
    reason?: string;
    subtype?: string;
    [key: string]: unknown;
  };
  created_at: string;
  status: AlertStatus;
  state_updated_at: string;
  symbol?: string;
  display_name?: string | null;
}

export type EventFlagOrigin = "DETECTED" | "MANUAL";

export const MANUAL_EVENT_KINDS = [
  "RESULTS_DATE_UPCOMING",
  "MATERIAL_NEGATIVE",
  "ORDER_WIN",
  "REGULATORY",
  "MANAGEMENT",
  "OTHER",
] as const;

export type ManualEventKind = typeof MANUAL_EVENT_KINDS[number];

export type EventFlagKind =
  | "RESULTS_PUBLISHED"
  | "CORPORATE_ACTION"
  | "LARGE_MOVE_DAY"
  | ManualEventKind
  | string;

export interface EventFlagRecord {
  id: string;
  stock_id: string;
  kind: EventFlagKind;
  origin: EventFlagOrigin;
  event_date: string;
  headline: string;
  source_url: string | null;
  detail_json: Record<string, unknown>;
  supersedes_id: string | null;
  created_at: string;
  symbol?: string;
}

export const EQUITY_ALERT_FOOTER =
  "Reference only. Not a forecast. In our test of six rule sets on 433 stocks none showed an edge.";

