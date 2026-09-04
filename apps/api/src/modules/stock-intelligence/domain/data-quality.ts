export const stockIntelligenceHorizons = ["6M", "12M"] as const;
export type StockIntelligenceHorizon = (typeof stockIntelligenceHorizons)[number];

/** Defaults. Overridden by environment so they are not baked into engine code. */
export const DEFAULT_STALE_DATA_DAYS_6M = 30;
export const DEFAULT_STALE_DATA_DAYS_12M = 60;
export const DEFAULT_FUNDAMENTAL_COMPLETENESS_MIN = 0.7;
export const DEFAULT_MIN_EFFECTIVE_ANALOGUES = 50;

export interface StaleDataThresholds {
  readonly days6M: number;
  readonly days12M: number;
}

export function staleDataThresholdDays(
  horizon: StockIntelligenceHorizon,
  thresholds: StaleDataThresholds,
): number {
  return horizon === "6M" ? thresholds.days6M : thresholds.days12M;
}

export function isStaleData(ageDays: number, horizon: StockIntelligenceHorizon, thresholds: StaleDataThresholds): boolean {
  return ageDays > staleDataThresholdDays(horizon, thresholds);
}

/**
 * Weighted freshness, not field-exists. A field older than its max age contributes 0.
 * Weights sum to 1.0 so the score is in [0, 1].
 */
export const FUNDAMENTAL_REQUIRED_FIELDS: Readonly<Record<string, number>> = {
  revenue_ttm: 0.15,
  net_income_ttm: 0.15,
  eps_ttm: 0.12,
  total_debt: 0.10,
  book_value_per_share: 0.08,
  roe: 0.10,
  operating_cash_flow: 0.12,
  promoter_holding: 0.10,
  capex_ttm: 0.08,
};

export const FUNDAMENTAL_MAX_AGE_DAYS: Readonly<Record<string, number>> = {
  revenue_ttm: 120,
  net_income_ttm: 120,
  eps_ttm: 120,
  total_debt: 180,
  book_value_per_share: 365,
  roe: 120,
  operating_cash_flow: 180,
  promoter_holding: 90,
  capex_ttm: 180,
};

export interface PitFundamentalRecord {
  readonly field: string;
  readonly availableAt: Date;
}

export function ageInUtcDays(asOf: Date, availableAt: Date): number {
  const ms = asOf.getTime() - availableAt.getTime();
  return ms / 86_400_000;
}

export function fundamentalCompleteness(
  asOf: Date,
  records: readonly PitFundamentalRecord[],
): number {
  const latestByField = new Map<string, Date>();
  for (const record of records) {
    if (record.availableAt.getTime() > asOf.getTime()) continue;
    const current = latestByField.get(record.field);
    if (!current || record.availableAt.getTime() > current.getTime()) {
      latestByField.set(record.field, record.availableAt);
    }
  }

  let score = 0;
  for (const [field, weight] of Object.entries(FUNDAMENTAL_REQUIRED_FIELDS)) {
    const availableAt = latestByField.get(field);
    if (!availableAt) continue;
    const maxAge = FUNDAMENTAL_MAX_AGE_DAYS[field] ?? 0;
    if (maxAge <= 0) continue;
    const freshness = Math.max(0, 1 - ageInUtcDays(asOf, availableAt) / maxAge);
    score += weight * freshness;
  }
  return score;
}

export interface DataQualityScores {
  readonly overall: number;
  readonly fundamentalCompleteness: number;
  readonly marketDataCompleteness: number;
  readonly documentCoverage: number;
}

export function overallDataQuality(input: Omit<DataQualityScores, "overall">): DataQualityScores {
  return {
    overall: (input.fundamentalCompleteness + input.marketDataCompleteness + input.documentCoverage) / 3,
    ...input,
  };
}

/** Calendar lookback used for Week 3 market completeness until a session calendar is wired. */
export const DEFAULT_MARKET_LOOKBACK_CALENDAR_DAYS = 60;
/** ~40 NSE sessions in 60 calendar days. Not a holiday calendar. */
export const DEFAULT_MARKET_EXPECTED_TRADING_DAYS = 40;

export function marketDataCompleteness(input: {
  asOf: Date;
  bars: readonly { availableAt: Date }[];
  lookbackCalendarDays?: number;
  expectedTradingDays?: number;
}): number {
  const lookback = input.lookbackCalendarDays ?? DEFAULT_MARKET_LOOKBACK_CALENDAR_DAYS;
  const expected = input.expectedTradingDays ?? DEFAULT_MARKET_EXPECTED_TRADING_DAYS;
  if (expected <= 0) return 0;
  const windowStart = new Date(input.asOf.getTime() - lookback * 86_400_000);
  let count = 0;
  for (const bar of input.bars) {
    if (!(bar.availableAt instanceof Date) || Number.isNaN(bar.availableAt.getTime())) continue;
    if (bar.availableAt.getTime() > input.asOf.getTime()) continue;
    if (bar.availableAt.getTime() < windowStart.getTime()) continue;
    count += 1;
  }
  return Math.min(1, count / expected);
}
