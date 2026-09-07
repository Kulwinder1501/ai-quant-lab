export const stockIntelligenceFeatureEngines = [
  "fundamental",
  "technical",
  "valuation",
  "event",
  "macro_sector",
] as const;
export type StockIntelligenceFeatureEngine = (typeof stockIntelligenceFeatureEngines)[number];

/**
 * Frozen M01 set. Additions require a `feature_version` bump and a full replay re-run.
 * Count is 20: 5 + 5 + 4 + 3 + 3.
 */
export const STOCK_INTELLIGENCE_FEATURE_CATALOG = [
  { name: "revenue_growth_yoy", engine: "fundamental" },
  { name: "net_margin_ttm", engine: "fundamental" },
  { name: "roe_ttm", engine: "fundamental" },
  { name: "debt_to_equity", engine: "fundamental" },
  { name: "cash_flow_ratio", engine: "fundamental" },
  { name: "momentum_6m", engine: "technical" },
  { name: "momentum_12m", engine: "technical" },
  { name: "volatility_60d", engine: "technical" },
  { name: "rsi_14d", engine: "technical" },
  { name: "drawdown_52w", engine: "technical" },
  { name: "pe_ttm", engine: "valuation" },
  { name: "pb_ttm", engine: "valuation" },
  { name: "ev_to_ebitda", engine: "valuation" },
  { name: "dividend_yield", engine: "valuation" },
  { name: "corporate_action_flag", engine: "event" },
  { name: "earnings_surprise_recent", engine: "event" },
  { name: "promoter_holding_change", engine: "event" },
  { name: "sector_relative_strength_6m", engine: "macro_sector" },
  { name: "macro_regime", engine: "macro_sector" },
  { name: "liquidity_regime", engine: "macro_sector" },
] as const satisfies ReadonlyArray<{ name: string; engine: StockIntelligenceFeatureEngine }>;

export type StockIntelligenceFeatureName = (typeof STOCK_INTELLIGENCE_FEATURE_CATALOG)[number]["name"];

export const STOCK_INTELLIGENCE_FEATURE_NAMES: readonly StockIntelligenceFeatureName[] =
  STOCK_INTELLIGENCE_FEATURE_CATALOG.map((row) => row.name);

export const DATA_QUALITY_SIGNAL_NAME = "data_quality";

export const featureUnavailableReasons = [
  "INSUFFICIENT_HISTORY",
  "MISSING_FUNDAMENTAL",
  "MISSING_SHAREHOLDERS_EQUITY",
  "MISSING_PRICE",
  "MISSING_ESTIMATE",
  "ADAPTER_NOT_IMPLEMENTED",
  "DIVIDE_BY_ZERO",
] as const;
export type FeatureUnavailableReason = (typeof featureUnavailableReasons)[number];

export interface FeatureValue {
  readonly name: StockIntelligenceFeatureName;
  readonly engine: StockIntelligenceFeatureEngine;
  readonly value: number | string | null;
  readonly unavailableReason: FeatureUnavailableReason | null;
}

export function isCompleteFeatureCatalog(names: readonly string[]): boolean {
  return names.length === STOCK_INTELLIGENCE_FEATURE_NAMES.length
    && STOCK_INTELLIGENCE_FEATURE_NAMES.every((name) => names.includes(name));
}
