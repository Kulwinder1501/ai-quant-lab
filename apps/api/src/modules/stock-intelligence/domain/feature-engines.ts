import type { CanonicalMarketBar } from "./adapters.js";
import type { AsReportedFundamental, CanonicalFact, CorporateActionRecord } from "./canonical.js";
import {
  STOCK_INTELLIGENCE_FEATURE_CATALOG,
  type FeatureUnavailableReason,
  type FeatureValue,
  type StockIntelligenceFeatureName,
} from "./feature-catalog.js";
import { selectBarsAsOf } from "./pit-audit.js";
import { classifyMacroRegimeFromNifty } from "./regime-engine.js";

export const MOMENTUM_6M_BARS = 126;
export const MOMENTUM_12M_BARS = 252;
export const VOLATILITY_BARS = 60;
export const RSI_PERIOD = 14;
export const DRAWDOWN_BARS = 252;
export const CORPORATE_ACTION_LOOKBACK_DAYS = 90;
export const DIVIDEND_YIELD_LOOKBACK_DAYS = 365;
export const YOY_MIN_SEPARATION_DAYS = 300;

export interface FeatureEngineInput {
  readonly instrumentId: string;
  readonly asOf: Date;
  readonly bars: readonly CanonicalMarketBar[];
  readonly indexBars?: readonly CanonicalMarketBar[];
  readonly vixBars?: readonly CanonicalMarketBar[];
  readonly fundamentals: readonly AsReportedFundamental[];
  readonly actions: readonly CorporateActionRecord[];
  readonly facts: readonly CanonicalFact[];
}

function unavailable(name: StockIntelligenceFeatureName, engine: FeatureValue["engine"], reason: FeatureUnavailableReason): FeatureValue {
  return { name, engine, value: null, unavailableReason: reason };
}

function numeric(name: StockIntelligenceFeatureName, engine: FeatureValue["engine"], value: number): FeatureValue {
  return { name, engine, value, unavailableReason: null };
}

function textual(name: StockIntelligenceFeatureName, engine: FeatureValue["engine"], value: string): FeatureValue {
  return { name, engine, value, unavailableReason: null };
}

function parseClose(bar: CanonicalMarketBar): number | null {
  const close = Number(bar.close);
  return Number.isFinite(close) && close > 0 ? close : null;
}

function sortedCloses(bars: readonly CanonicalMarketBar[], asOf: Date): number[] {
  return selectBarsAsOf(bars, asOf)
    .map((bar) => parseClose(bar))
    .filter((close): close is number => close !== null);
}

function lastClose(bars: readonly CanonicalMarketBar[], asOf: Date): number | null {
  const closes = sortedCloses(bars, asOf);
  return closes[closes.length - 1] ?? null;
}

function momentum(closes: readonly number[], lookback: number): number | null {
  if (closes.length < lookback + 1) return null;
  const end = closes[closes.length - 1]!;
  const start = closes[closes.length - 1 - lookback]!;
  if (start <= 0) return null;
  return end / start - 1;
}

function realizedVolatility(closes: readonly number[], window: number): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - (window + 1));
  const returns: number[] = [];
  for (let index = 1; index < slice.length; index += 1) {
    const prev = slice[index - 1]!;
    const next = slice[index]!;
    if (prev <= 0 || next <= 0) continue;
    returns.push(Math.log(next / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function lastRsi(closes: readonly number[], period: number): number | null {
  if (closes.length <= period) return null;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const difference = closes[index]! - closes[index - 1]!;
    gains.push(Math.max(difference, 0));
    losses.push(Math.max(-difference, 0));
  }
  let averageGain = gains.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let averageLoss = losses.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const rsiFromAverages = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    return 100 - 100 / (1 + averageGain / averageLoss);
  };
  let value = rsiFromAverages();
  for (let index = period; index < gains.length; index += 1) {
    averageGain = (averageGain * (period - 1) + gains[index]!) / period;
    averageLoss = (averageLoss * (period - 1) + losses[index]!) / period;
    value = rsiFromAverages();
  }
  return value;
}

function drawdownFromPeak(closes: readonly number[], window: number): number | null {
  if (closes.length < 2) return null;
  const slice = closes.slice(Math.max(0, closes.length - window));
  const peak = Math.max(...slice);
  const last = slice[slice.length - 1]!;
  if (peak <= 0) return null;
  return last / peak - 1;
}

function asNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestFundamental(
  records: readonly AsReportedFundamental[],
  field: string,
  asOf: Date,
  origin?: AsReportedFundamental["origin"],
): AsReportedFundamental | null {
  const covering = records.filter((row) => {
    if (row.field !== field) return false;
    if (row.availableAt.getTime() > asOf.getTime()) return false;
    if (origin && row.origin !== origin) return false;
    return true;
  });
  covering.sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
  return covering[0] ?? null;
}

function priorFundamental(
  records: readonly AsReportedFundamental[],
  field: string,
  asOf: Date,
  latest: AsReportedFundamental,
  minSeparationDays: number,
): AsReportedFundamental | null {
  const latestPeriod = Date.parse(latest.periodEnd);
  const covering = records.filter((row) => {
    if (row.field !== field) return false;
    if (row.availableAt.getTime() > asOf.getTime()) return false;
    if (row.snapshotId === latest.snapshotId) return false;
    const period = Date.parse(row.periodEnd);
    if (Number.isNaN(latestPeriod) || Number.isNaN(period)) return false;
    return latestPeriod - period >= minSeparationDays * 86_400_000;
  });
  covering.sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
  return covering[0] ?? null;
}

function ratio(numerator: number | null, denominator: number | null): { value: number; reason: FeatureUnavailableReason | null } | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return { value: 0, reason: "DIVIDE_BY_ZERO" };
  return { value: numerator / denominator, reason: null };
}

export function computeTechnicalFeatures(input: FeatureEngineInput): FeatureValue[] {
  const closes = sortedCloses(input.bars, input.asOf);
  const mom6 = momentum(closes, MOMENTUM_6M_BARS);
  const mom12 = momentum(closes, MOMENTUM_12M_BARS);
  const vol = realizedVolatility(closes, VOLATILITY_BARS);
  const rsi = lastRsi(closes, RSI_PERIOD);
  const drawdown = drawdownFromPeak(closes, DRAWDOWN_BARS);
  return [
    mom6 === null ? unavailable("momentum_6m", "technical", "INSUFFICIENT_HISTORY") : numeric("momentum_6m", "technical", mom6),
    mom12 === null ? unavailable("momentum_12m", "technical", "INSUFFICIENT_HISTORY") : numeric("momentum_12m", "technical", mom12),
    vol === null ? unavailable("volatility_60d", "technical", "INSUFFICIENT_HISTORY") : numeric("volatility_60d", "technical", vol),
    rsi === null ? unavailable("rsi_14d", "technical", "INSUFFICIENT_HISTORY") : numeric("rsi_14d", "technical", rsi),
    drawdown === null ? unavailable("drawdown_52w", "technical", "INSUFFICIENT_HISTORY") : numeric("drawdown_52w", "technical", drawdown),
  ];
}

export function computeFundamentalFeatures(input: FeatureEngineInput): FeatureValue[] {
  const { fundamentals, asOf } = input;
  const revenue = latestFundamental(fundamentals, "revenue_ttm", asOf, "REPORTED_ACTUAL");
  const priorRevenue = revenue ? priorFundamental(fundamentals, "revenue_ttm", asOf, revenue, YOY_MIN_SEPARATION_DAYS) : null;
  const netIncome = latestFundamental(fundamentals, "net_income_ttm", asOf, "REPORTED_ACTUAL");
  const roe = latestFundamental(fundamentals, "roe", asOf, "REPORTED_ACTUAL");
  const debt = latestFundamental(fundamentals, "total_debt", asOf, "REPORTED_ACTUAL");
  const equity = latestFundamental(fundamentals, "shareholders_equity", asOf, "REPORTED_ACTUAL")
    ?? latestFundamental(fundamentals, "debt_to_equity", asOf, "REPORTED_ACTUAL");
  const cashFlow = latestFundamental(fundamentals, "operating_cash_flow", asOf, "REPORTED_ACTUAL");

  const growth = revenue && priorRevenue
    ? ratio(asNumber(revenue.value)! - asNumber(priorRevenue.value)!, Math.abs(asNumber(priorRevenue.value) ?? 0))
    : null;
  const margin = ratio(netIncome ? asNumber(netIncome.value) : null, revenue ? asNumber(revenue.value) : null);
  const cashRatio = ratio(cashFlow ? asNumber(cashFlow.value) : null, netIncome ? asNumber(netIncome.value) : null);

  let debtToEquity: FeatureValue;
  if (!debt) {
    debtToEquity = unavailable("debt_to_equity", "fundamental", "MISSING_FUNDAMENTAL");
  } else if (equity?.field === "debt_to_equity") {
    const value = asNumber(equity.value);
    debtToEquity = value === null
      ? unavailable("debt_to_equity", "fundamental", "MISSING_FUNDAMENTAL")
      : numeric("debt_to_equity", "fundamental", value);
  } else if (!equity) {
    debtToEquity = unavailable("debt_to_equity", "fundamental", "MISSING_SHAREHOLDERS_EQUITY");
  } else {
    const computed = ratio(asNumber(debt.value), asNumber(equity.value));
    debtToEquity = !computed
      ? unavailable("debt_to_equity", "fundamental", "MISSING_FUNDAMENTAL")
      : computed.reason
        ? unavailable("debt_to_equity", "fundamental", computed.reason)
        : numeric("debt_to_equity", "fundamental", computed.value);
  }

  return [
    !revenue || !priorRevenue || !growth
      ? unavailable("revenue_growth_yoy", "fundamental", "INSUFFICIENT_HISTORY")
      : growth.reason
        ? unavailable("revenue_growth_yoy", "fundamental", growth.reason)
        : numeric("revenue_growth_yoy", "fundamental", growth.value),
    !margin
      ? unavailable("net_margin_ttm", "fundamental", "MISSING_FUNDAMENTAL")
      : margin.reason
        ? unavailable("net_margin_ttm", "fundamental", margin.reason)
        : numeric("net_margin_ttm", "fundamental", margin.value),
    (() => {
      const value = roe ? asNumber(roe.value) : null;
      return value === null
        ? unavailable("roe_ttm", "fundamental", "MISSING_FUNDAMENTAL")
        : numeric("roe_ttm", "fundamental", value);
    })(),
    debtToEquity,
    !cashRatio
      ? unavailable("cash_flow_ratio", "fundamental", "MISSING_FUNDAMENTAL")
      : cashRatio.reason
        ? unavailable("cash_flow_ratio", "fundamental", cashRatio.reason)
        : numeric("cash_flow_ratio", "fundamental", cashRatio.value),
  ];
}

function trailingDividends(actions: readonly CorporateActionRecord[], asOf: Date): number {
  const windowStart = asOf.getTime() - DIVIDEND_YIELD_LOOKBACK_DAYS * 86_400_000;
  let sum = 0;
  for (const action of actions) {
    if (action.actionType !== "DIVIDEND") continue;
    if (action.availableAt.getTime() > asOf.getTime()) continue;
    if (action.availableAt.getTime() < windowStart) continue;
    const amount = action.details.amountPerShare;
    const parsed = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : NaN;
    if (Number.isFinite(parsed)) sum += parsed;
  }
  return sum;
}

export function computeValuationFeatures(input: FeatureEngineInput): FeatureValue[] {
  const price = lastClose(input.bars, input.asOf);
  const eps = latestFundamental(input.fundamentals, "eps_ttm", input.asOf, "REPORTED_ACTUAL");
  const book = latestFundamental(input.fundamentals, "book_value_per_share", input.asOf, "REPORTED_ACTUAL");
  const ev = latestFundamental(input.fundamentals, "enterprise_value", input.asOf, "REPORTED_ACTUAL");
  const ebitda = latestFundamental(input.fundamentals, "ebitda_ttm", input.asOf, "REPORTED_ACTUAL");

  const pe = ratio(price, eps ? asNumber(eps.value) : null);
  const pb = ratio(price, book ? asNumber(book.value) : null);
  const evebitda = ratio(ev ? asNumber(ev.value) : null, ebitda ? asNumber(ebitda.value) : null);
  const yieldAmount = trailingDividends(input.actions, input.asOf);

  return [
    price === null
      ? unavailable("pe_ttm", "valuation", "MISSING_PRICE")
      : !pe
        ? unavailable("pe_ttm", "valuation", "MISSING_FUNDAMENTAL")
        : pe.reason
          ? unavailable("pe_ttm", "valuation", pe.reason)
          : numeric("pe_ttm", "valuation", pe.value),
    price === null
      ? unavailable("pb_ttm", "valuation", "MISSING_PRICE")
      : !pb
        ? unavailable("pb_ttm", "valuation", "MISSING_FUNDAMENTAL")
        : pb.reason
          ? unavailable("pb_ttm", "valuation", pb.reason)
          : numeric("pb_ttm", "valuation", pb.value),
    !evebitda
      ? unavailable("ev_to_ebitda", "valuation", "MISSING_FUNDAMENTAL")
      : evebitda.reason
        ? unavailable("ev_to_ebitda", "valuation", evebitda.reason)
        : numeric("ev_to_ebitda", "valuation", evebitda.value),
    price === null
      ? unavailable("dividend_yield", "valuation", "MISSING_PRICE")
      : price === 0
        ? unavailable("dividend_yield", "valuation", "DIVIDE_BY_ZERO")
        : numeric("dividend_yield", "valuation", yieldAmount / price),
  ];
}

const MATERIAL_ACTION_TYPES = new Set(["SPLIT", "BONUS", "RIGHTS", "BUYBACK", "MERGER", "DELISTING"]);

export function computeEventFeatures(input: FeatureEngineInput): FeatureValue[] {
  const windowStart = input.asOf.getTime() - CORPORATE_ACTION_LOOKBACK_DAYS * 86_400_000;
  const flagged = input.actions.some((action) =>
    MATERIAL_ACTION_TYPES.has(action.actionType)
    && action.availableAt.getTime() <= input.asOf.getTime()
    && action.availableAt.getTime() >= windowStart
  );

  const actual = latestFundamental(input.fundamentals, "eps_ttm", input.asOf, "REPORTED_ACTUAL");
  const estimate = actual
    ? input.fundamentals
      .filter((row) =>
        row.field === "eps_ttm"
        && row.origin === "ANALYST_ESTIMATE"
        && row.periodEnd === actual.periodEnd
        && row.availableAt.getTime() <= input.asOf.getTime()
        && row.availableAt.getTime() <= actual.availableAt.getTime()
      )
      .sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime())[0] ?? null
    : null;
  const actualValue = actual ? asNumber(actual.value) : null;
  const estimateValue = estimate ? asNumber(estimate.value) : null;
  let surprise: FeatureValue;
  if (actualValue === null) {
    surprise = unavailable("earnings_surprise_recent", "event", "MISSING_FUNDAMENTAL");
  } else if (estimateValue === null) {
    surprise = unavailable("earnings_surprise_recent", "event", "MISSING_ESTIMATE");
  } else if (estimateValue === 0) {
    surprise = unavailable("earnings_surprise_recent", "event", "DIVIDE_BY_ZERO");
  } else {
    surprise = numeric("earnings_surprise_recent", "event", (actualValue - estimateValue) / Math.abs(estimateValue));
  }

  const promoter = latestFundamental(input.fundamentals, "promoter_holding", input.asOf, "REPORTED_ACTUAL");
  const priorPromoter = promoter
    ? priorFundamental(input.fundamentals, "promoter_holding", input.asOf, promoter, 60)
    : null;
  const promoterChange = promoter && priorPromoter
    ? ratio(
      (asNumber(promoter.value) ?? 0) - (asNumber(priorPromoter.value) ?? 0),
      1,
    )
    : null;

  return [
    numeric("corporate_action_flag", "event", flagged ? 1 : 0),
    surprise,
    !promoter || !priorPromoter || !promoterChange
      ? unavailable("promoter_holding_change", "event", "INSUFFICIENT_HISTORY")
      : numeric("promoter_holding_change", "event", promoterChange.value),
  ];
}

export function computeMacroSectorFeatures(input: FeatureEngineInput): FeatureValue[] {
  const stockMom = momentum(sortedCloses(input.bars, input.asOf), MOMENTUM_6M_BARS);
  const indexMom = input.indexBars
    ? momentum(sortedCloses(input.indexBars, input.asOf), MOMENTUM_6M_BARS)
    : null;
  const relative = stockMom !== null && indexMom !== null ? stockMom - indexMom : null;
  const niftyTech = input.indexBars
    ? computeTechnicalFeatures({ ...input, bars: input.indexBars })
    : [];
  const niftyMom12 = niftyTech.find((row) => row.name === "momentum_12m");
  const niftyDrawdown = niftyTech.find((row) => row.name === "drawdown_52w");
  const macro = niftyMom12?.unavailableReason === null && niftyDrawdown?.unavailableReason === null
    && typeof niftyMom12?.value === "number" && typeof niftyDrawdown?.value === "number"
    ? classifyMacroRegimeFromNifty(niftyMom12.value, niftyDrawdown.value)
    : null;

  return [
    relative === null
      ? unavailable("sector_relative_strength_6m", "macro_sector", "INSUFFICIENT_HISTORY")
      : numeric("sector_relative_strength_6m", "macro_sector", relative),
    macro
      ? textual("macro_regime", "macro_sector", macro)
      : unavailable("macro_regime", "macro_sector", input.indexBars ? "INSUFFICIENT_HISTORY" : "ADAPTER_NOT_IMPLEMENTED"),
    unavailable("liquidity_regime", "macro_sector", "ADAPTER_NOT_IMPLEMENTED"),
  ];
}

export function computeFeatureSet(input: FeatureEngineInput): FeatureValue[] {
  const features = [
    ...computeFundamentalFeatures(input),
    ...computeTechnicalFeatures(input),
    ...computeValuationFeatures(input),
    ...computeEventFeatures(input),
    ...computeMacroSectorFeatures(input),
  ];
  const byName = new Map(features.map((feature) => [feature.name, feature]));
  return STOCK_INTELLIGENCE_FEATURE_CATALOG.map((row) => {
    const computed = byName.get(row.name);
    if (!computed) return unavailable(row.name, row.engine, "MISSING_FUNDAMENTAL");
    return computed;
  });
}
