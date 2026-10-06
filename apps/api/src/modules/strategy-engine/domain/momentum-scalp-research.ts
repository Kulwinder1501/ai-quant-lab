import type { BacktestConfiguration, BacktestMetrics } from "../../backtesting/domain/backtesting.js";
import { BacktestEngine, defaultBacktestConfiguration } from "../../backtesting/domain/backtest-engine.js";
import { TechnicalIndicatorEngine } from "../../technical-analysis/domain/technical-indicator-engine.js";
import type { IndicatorDefinitionSpec } from "../../technical-analysis/domain/technical-indicator.js";
import type { StrategyMarketContext } from "./strategy.js";
import {
  defaultMomentumScalpStrategyConfiguration,
  type MomentumScalpStrategyConfiguration,
  MomentumScalpStrategy,
} from "./momentum-scalp-strategy.js";

export interface ScalpEntryProfile {
  name: string;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  configuration: MomentumScalpStrategyConfiguration;
}

export interface ScalpExitProfile {
  name: string;
  atrStopMultiple: number;
  rewardRiskMultiple: number;
}

export interface ScalpProfileResult {
  entryProfile: string;
  exitProfile: string;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  atrStopMultiple: number;
  rewardRiskMultiple: number;
  sessions: number;
  signalsPerSession: number;
  tradesPerSession: number;
  metrics: BacktestMetrics;
}

export interface EmaWhipsawDiagnostic {
  emaPair: string;
  crossovers: number;
  quickReversalsWithinFiveBars: number;
}

export interface VwapTimeBucketDiagnostic {
  bucket: string;
  bars: number;
  medianAbsoluteDisplacementAtr: number;
  p90AbsoluteDisplacementAtr: number;
  insideProductionWindow: number;
  insideProductionWindowPercent: number;
}

const emaDefinition = (period: number): IndicatorDefinitionSpec => ({
  code: "EMA",
  algorithmVersion: "ta-v1",
  parameters: { period },
  outputSchema: { value: "number" },
});

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function indicatorValue(
  context: StrategyMarketContext,
  code: "ATR" | "VWAP",
  parameters: Record<string, number | string | boolean>,
): number | null {
  const snapshot = context.indicators.find((candidate) => (
    candidate.code === code
    && candidate.algorithmVersion === "ta-v1"
    && Object.entries(parameters).every(([key, value]) => candidate.parameters[key] === value)
  ));
  const value = snapshot?.values.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Adds research-only EMA snapshots in memory. Nothing is registered or persisted,
 * so swing indicators and the production strategy remain untouched.
 */
export function withResearchEmaSnapshots(
  contexts: readonly StrategyMarketContext[],
  periods: readonly number[] = [3, 5, 8, 13],
): StrategyMarketContext[] {
  const engine = new TechnicalIndicatorEngine();
  const candles = contexts.map((context) => context.candle);
  const valuesByPeriod = new Map<number, Map<string, Record<string, number | string | boolean | null>>>();
  for (const period of periods) {
    const points = engine.calculate(candles, emaDefinition(period));
    valuesByPeriod.set(period, new Map(points.map((point) => [point.candleId, point.values])));
  }
  return contexts.map((context) => {
    const researchPeriods = new Set(periods);
    const indicators = context.indicators.filter((snapshot) => !(
      snapshot.code === "EMA"
      && snapshot.algorithmVersion === "ta-v1"
      && typeof snapshot.parameters.period === "number"
      && researchPeriods.has(snapshot.parameters.period)
    ));
    for (const period of periods) {
      const values = valuesByPeriod.get(period)?.get(context.candle.id);
      if (values) {
        indicators.push({ code: "EMA", algorithmVersion: "ta-v1", parameters: { period }, values });
      }
    }
    return { ...context, indicators };
  });
}

function configurationFor(
  emaFastPeriod: number,
  emaSlowPeriod: number,
  overrides: Partial<MomentumScalpStrategyConfiguration> = {},
): MomentumScalpStrategyConfiguration {
  return {
    ...defaultMomentumScalpStrategyConfiguration,
    ...overrides,
    indicatorParameters: {
      ...defaultMomentumScalpStrategyConfiguration.indicatorParameters,
      EMA_FAST: { period: emaFastPeriod },
      EMA_SLOW: { period: emaSlowPeriod },
    },
  };
}

export function scalpResearchEntryProfiles(): ScalpEntryProfile[] {
  const revisedTerms: Partial<MomentumScalpStrategyConfiguration> = {
    rsiLongMin: 55,
    rsiLongMax: 75,
    // Mirror the revised long band around RSI 50.
    rsiShortMin: 25,
    rsiShortMax: 45,
    minimumVwapDisplacementAtr: 0.10,
    idealVwapDisplacementAtr: 0.40,
  };
  return [
    // profile[0]: current production config — must equal defaultMomentumScalpStrategyConfiguration
    {
      name: "production-control-ema-3-8",
      emaFastPeriod: 3,
      emaSlowPeriod: 8,
      configuration: configurationFor(3, 8),
    },
    // Legacy EMA(9/20) kept for comparison; not used in production.
    {
      name: "legacy-ema-9-20",
      emaFastPeriod: 9,
      emaSlowPeriod: 20,
      configuration: configurationFor(9, 20),
    },
    ...([[5, 13], [3, 8]] as const).map(([fast, slow]) => ({
      name: `revised-entry-ema-${fast}-${slow}`,
      emaFastPeriod: fast,
      emaSlowPeriod: slow,
      configuration: configurationFor(fast, slow, revisedTerms),
    })),
  ];
}

export function scalpResearchExitProfiles(): ScalpExitProfile[] {
  return [
    { name: "stop-0.5-atr-target-1.0r", atrStopMultiple: 0.5, rewardRiskMultiple: 1.0 },
    { name: "stop-1.0-atr-target-1.0r", atrStopMultiple: 1.0, rewardRiskMultiple: 1.0 },
    { name: "stop-1.0-atr-target-1.5r", atrStopMultiple: 1.0, rewardRiskMultiple: 1.5 },
  ];
}

export function compareScalpProfiles(
  contexts: readonly StrategyMarketContext[],
  execution: BacktestConfiguration,
): ScalpProfileResult[] {
  const engine = new BacktestEngine(new MomentumScalpStrategy());
  const sessions = new Set(contexts.map((context) => istSessionDate(context.candle.closeTime))).size;
  return scalpResearchEntryProfiles().flatMap((entry) => scalpResearchExitProfiles().map((exit) => {
    const strategyConfiguration: MomentumScalpStrategyConfiguration = {
      ...entry.configuration,
      atrStopMultiple: exit.atrStopMultiple,
      rewardRiskMultiple: exit.rewardRiskMultiple,
    };
    const result = engine.run(contexts, strategyConfiguration as unknown as Record<string, unknown>, execution);
    return {
      entryProfile: entry.name,
      exitProfile: exit.name,
      emaFastPeriod: entry.emaFastPeriod,
      emaSlowPeriod: entry.emaSlowPeriod,
      atrStopMultiple: exit.atrStopMultiple,
      rewardRiskMultiple: exit.rewardRiskMultiple,
      sessions,
      signalsPerSession: sessions === 0 ? 0 : rounded(result.metrics.signalCount / sessions),
      tradesPerSession: sessions === 0 ? 0 : rounded(result.metrics.tradeCount / sessions),
      metrics: result.metrics,
    };
  }));
}

function emaValue(context: StrategyMarketContext, period: number): number | null {
  const snapshot = context.indicators.find((candidate) => (
    candidate.code === "EMA"
    && candidate.algorithmVersion === "ta-v1"
    && candidate.parameters.period === period
  ));
  const value = snapshot?.values.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function emaWhipsawDiagnostics(
  contexts: readonly StrategyMarketContext[],
  pairs: readonly (readonly [number, number])[] = [[9, 20], [5, 13], [3, 8]],
): EmaWhipsawDiagnostic[] {
  return pairs.map(([fast, slow]) => {
    let previousDirection = 0;
    let previousCrossIndex: number | null = null;
    let crossovers = 0;
    let quickReversalsWithinFiveBars = 0;
    contexts.forEach((context, index) => {
      const fastValue = emaValue(context, fast);
      const slowValue = emaValue(context, slow);
      if (fastValue === null || slowValue === null) return;
      const direction = fastValue > slowValue ? 1 : fastValue < slowValue ? -1 : 0;
      if (direction !== 0 && previousDirection !== 0 && direction !== previousDirection) {
        crossovers += 1;
        if (previousCrossIndex !== null && index - previousCrossIndex <= 5) {
          quickReversalsWithinFiveBars += 1;
        }
        previousCrossIndex = index;
      }
      if (direction !== 0) previousDirection = direction;
    });
    return { emaPair: `${fast}/${slow}`, crossovers, quickReversalsWithinFiveBars };
  });
}

function istMinuteOfDay(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function istSessionDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((candidate) => candidate.type === type)?.value ?? ""
  );
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function sessionBucket(closeTime: Date): string {
  const minute = istMinuteOfDay(closeTime);
  if (minute < 10 * 60) return "09:15-10:00 IST";
  if (minute < 12 * 60) return "10:00-12:00 IST";
  if (minute < 14 * 60) return "12:00-14:00 IST";
  return "14:00-15:30 IST";
}

export function vwapTimeBucketDiagnostics(contexts: readonly StrategyMarketContext[]): VwapTimeBucketDiagnostic[] {
  const buckets = new Map<string, number[]>();
  for (const context of contexts) {
    const vwap = indicatorValue(context, "VWAP", { reset: "NSE_SESSION" });
    const atr = indicatorValue(context, "ATR", { period: 14 });
    if (vwap === null || atr === null || atr <= 0) continue;
    const displacement = Math.abs(context.candle.close - vwap) / atr;
    const bucket = sessionBucket(context.candle.closeTime);
    const values = buckets.get(bucket) ?? [];
    values.push(displacement);
    buckets.set(bucket, values);
  }
  const order = ["09:15-10:00 IST", "10:00-12:00 IST", "12:00-14:00 IST", "14:00-15:30 IST"];
  return order.flatMap((bucket) => {
    const values = buckets.get(bucket);
    if (!values?.length) return [];
    const sorted = [...values].sort((left, right) => left - right);
    const inside = sorted.filter((value) => (
      value > defaultMomentumScalpStrategyConfiguration.minimumVwapDisplacementAtr
      && value < defaultMomentumScalpStrategyConfiguration.maximumVwapDisplacementAtr
    )).length;
    return [{
      bucket,
      bars: sorted.length,
      medianAbsoluteDisplacementAtr: rounded(percentile(sorted, 0.5)),
      p90AbsoluteDisplacementAtr: rounded(percentile(sorted, 0.9)),
      insideProductionWindow: inside,
      insideProductionWindowPercent: rounded(inside / sorted.length * 100),
    }];
  });
}

export function scalpResearchExecutionConfiguration(input: {
  initialCapital: number;
  feePerOrder: number;
  slippageBps: number;
  riskFractionPerTrade: number;
  marginFraction: number;
}): BacktestConfiguration {
  return {
    ...defaultBacktestConfiguration,
    initialCapital: input.initialCapital,
    feePerOrder: input.feePerOrder,
    slippageBps: input.slippageBps,
    positionSizing: "CONSTANT_RISK_FRACTION",
    riskFractionPerTrade: input.riskFractionPerTrade,
    // Explicit because narrow scalp stops and constant-risk sizing can otherwise
    // imply a notional larger than the account and turn every signal into a
    // funding rejection. The caller must state the leverage model it intends.
    marginFraction: input.marginFraction,
  };
}
