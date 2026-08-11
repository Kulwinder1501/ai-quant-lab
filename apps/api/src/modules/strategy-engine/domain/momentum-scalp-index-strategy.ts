import type { VolatilityRegime } from "./regime.js";
import {
  type ProposedTradeIdea,
  type StrategyMarketContext,
  type TradeIdeaEvidence,
  type TradeSide,
} from "./strategy.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundDownToTick(value: number, tickSize: number): number {
  return Math.floor(value / tickSize) * tickSize;
}

function roundUpToTick(value: number, tickSize: number): number {
  return Math.ceil(value / tickSize) * tickSize;
}

function roundNearestToTick(value: number, tickSize: number): number {
  return Math.round(value / tickSize) * tickSize;
}

function timeframeMilliseconds(timeframe: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe);
  if (!match) return null;
  const unitMilliseconds = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * unitMilliseconds;
}

type IndicatorSnapshot = StrategyMarketContext["indicators"][number];

export const momentumScalpIndexStrategyVersion = 1;

export interface MomentumScalpIndexStrategyConfiguration {
  indicatorAlgorithmVersion: string;
  indicatorParameters: Record<string, Record<string, number | string | boolean>>;
  candlestickAlgorithmVersion: string;
  priceActionAlgorithmVersion: string;
  rsiLongMin: number;
  rsiLongMax: number;
  rsiShortMin: number;
  rsiShortMax: number;
  atrStopMultiple: number;
  rewardRiskMultiple: number;
  minimumConfidence: number;
  expiryCandles: number;
  requireRegime: boolean;
}

export const defaultMomentumScalpIndexStrategyConfiguration: MomentumScalpIndexStrategyConfiguration = {
  indicatorAlgorithmVersion: "ta-v1",
  indicatorParameters: {
    EMA_FAST: { period: 3 },
    EMA_SLOW: { period: 8 },
    RSI: { period: 14, smoothing: "WILDER" },
    SUPERTREND: { atrPeriod: 10, multiplier: 3 },
    ATR: { period: 14, smoothing: "WILDER" },
  },
  candlestickAlgorithmVersion: "candlestick-v1",
  priceActionAlgorithmVersion: "price-action-v2",
  rsiLongMin: 55,
  rsiLongMax: 75,
  rsiShortMin: 25,
  rsiShortMax: 45,
  atrStopMultiple: 1.0,
  rewardRiskMultiple: 1.5,
  minimumConfidence: 0.5,
  expiryCandles: 3,
  requireRegime: false,
};

export const momentumScalpIndexStrategyRegistration = {
  strategyKey: "momentum-scalp-index",
  name: "Momentum Scalp (Index)",
  description: "Fast EMA separation confirmed by Supertrend direction and a bounded RSI momentum band.",
  version: momentumScalpIndexStrategyVersion,
  configuration: { ...defaultMomentumScalpIndexStrategyConfiguration } as Record<string, unknown>,
};

function requiredNumber(raw: Record<string, unknown>, key: string, min = -Infinity, max = Infinity): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Momentum scalp index configuration requires a valid numeric ${key} between ${min} and ${max}.`);
  }
  return value;
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Momentum scalp index configuration requires a valid string ${key}.`);
  }
  return value.trim();
}

function requiredBoolean(raw: Record<string, unknown>, key: string): boolean {
  if (typeof raw[key] !== "boolean") {
    throw new Error(`Momentum scalp index configuration requires a boolean ${key}.`);
  }
  return raw[key] as boolean;
}

function requiredIndicatorParameters(raw: Record<string, unknown>): Record<string, Record<string, number | string | boolean>> {
  const candidate = raw.indicatorParameters;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Momentum scalp index configuration requires indicator parameter sets.");
  }
  const result: Record<string, Record<string, number | string | boolean>> = {};
  for (const code of ["EMA_FAST", "EMA_SLOW", "RSI", "SUPERTREND", "ATR"]) {
    const parameters = (candidate as Record<string, unknown>)[code];
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length === 0) {
      throw new Error(`Momentum scalp index configuration requires parameters for ${code}.`);
    }
    const typed: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
        throw new Error(`Momentum scalp index configuration has an unsupported parameter for ${code}.`);
      }
      typed[key] = value;
    }
    result[code] = typed;
  }
  return result;
}

export function parseMomentumScalpIndexStrategyConfiguration(raw: Record<string, unknown>): MomentumScalpIndexStrategyConfiguration {
  const configuration: MomentumScalpIndexStrategyConfiguration = {
    indicatorAlgorithmVersion: requiredString(raw, "indicatorAlgorithmVersion"),
    indicatorParameters: requiredIndicatorParameters(raw),
    candlestickAlgorithmVersion: requiredString(raw, "candlestickAlgorithmVersion"),
    priceActionAlgorithmVersion: requiredString(raw, "priceActionAlgorithmVersion"),
    rsiLongMin: requiredNumber(raw, "rsiLongMin", 0, 100),
    rsiLongMax: requiredNumber(raw, "rsiLongMax", 0, 100),
    rsiShortMin: requiredNumber(raw, "rsiShortMin", 0, 100),
    rsiShortMax: requiredNumber(raw, "rsiShortMax", 0, 100),
    atrStopMultiple: requiredNumber(raw, "atrStopMultiple", Number.EPSILON),
    rewardRiskMultiple: requiredNumber(raw, "rewardRiskMultiple", Number.EPSILON),
    minimumConfidence: requiredNumber(raw, "minimumConfidence", 0, 1),
    expiryCandles: requiredNumber(raw, "expiryCandles", 1),
    requireRegime: requiredBoolean(raw, "requireRegime"),
  };
  if (configuration.rsiLongMax <= configuration.rsiLongMin) {
    throw new Error("Momentum scalp index configuration requires rsiLongMax to be greater than rsiLongMin.");
  }
  if (configuration.rsiShortMax <= configuration.rsiShortMin) {
    throw new Error("Momentum scalp index configuration requires rsiShortMax to be greater than rsiShortMin.");
  }
  return configuration;
}

interface ResolvedIndicators {
  emaFast: IndicatorSnapshot;
  emaSlow: IndicatorSnapshot;
  rsi: IndicatorSnapshot;
  supertrend: IndicatorSnapshot;
  atr: IndicatorSnapshot;
  emaFastValue: number;
  emaSlowValue: number;
  rsiValue: number;
  supertrendTrend: string;
  supertrendValue: number;
  atrValue: number;
}

function findIndicator(context: StrategyMarketContext, code: string, algorithmVersion: string, parameters: Record<string, number | string | boolean>): IndicatorSnapshot | null {
  for (const indicator of context.indicators) {
    if (indicator.code !== code || indicator.algorithmVersion !== algorithmVersion) continue;
    let match = true;
    for (const [key, value] of Object.entries(parameters)) {
      if (indicator.parameters[key] !== value) {
        match = false;
        break;
      }
    }
    if (match) return indicator;
  }
  return null;
}

function indicatorNumber(values: Record<string, unknown>, key: string): number | null {
  return typeof values[key] === "number" ? values[key] as number : null;
}

function indicatorString(values: Record<string, unknown>, key: string): string | null {
  return typeof values[key] === "string" ? values[key] as string : null;
}

function resolveIndicators(context: StrategyMarketContext, configuration: MomentumScalpIndexStrategyConfiguration): ResolvedIndicators | null {
  const emaFast = findIndicator(context, "EMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.EMA_FAST);
  const emaSlow = findIndicator(context, "EMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.EMA_SLOW);
  const rsi = findIndicator(context, "RSI", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.RSI);
  const supertrend = findIndicator(context, "SUPERTREND", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.SUPERTREND);
  const atr = findIndicator(context, "ATR", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.ATR);

  if (!emaFast || !emaSlow || !rsi || !supertrend || !atr) return null;

  const emaFastValue = indicatorNumber(emaFast.values, "value");
  const emaSlowValue = indicatorNumber(emaSlow.values, "value");
  const rsiValue = indicatorNumber(rsi.values, "value");
  const supertrendTrend = indicatorString(supertrend.values, "trend");
  const supertrendValue = indicatorNumber(supertrend.values, "value");
  const atrValue = indicatorNumber(atr.values, "value");

  if (emaFastValue === null || emaSlowValue === null || rsiValue === null || supertrendTrend === null || supertrendValue === null || atrValue === null || atrValue <= 0) return null;
  return { emaFast, emaSlow, rsi, supertrend, atr, emaFastValue, emaSlowValue, rsiValue, supertrendTrend, supertrendValue, atrValue };
}

function rsiMomentumScore(rsiValue: number, side: TradeSide, configuration: MomentumScalpIndexStrategyConfiguration): number {
  const low = side === "LONG" ? configuration.rsiLongMin : configuration.rsiShortMin;
  const high = side === "LONG" ? configuration.rsiLongMax : configuration.rsiShortMax;
  if (!(high > low)) return 0;
  const position = (rsiValue - low) / (high - low);
  return clamp(1 - Math.abs(position - 0.5) * 2);
}

/**
 * How much room the trend has before Supertrend would flip, in ATR units.
 *
 * Supertrend's `value` is the trailing band the trend rides: for an uptrend it sits below price and
 * a close through it flips the trend down. Distance from price to that band is therefore the
 * headroom the signal has, and it is the one thing the direction gate cannot express -- a close one
 * tick above the band and a close two ATR above it both read as `trend === "UP"`.
 *
 * Normalised by ATR so it means the same thing on a 1m NIFTY bar and a 5m BANKNIFTY one, and
 * clamped: beyond one ATR of headroom, more distance stops being reassuring and starts being
 * extension. The sign is folded out here because `evaluate` has already established that price is
 * on the correct side of the band for the side under test.
 */
function supertrendBandScore(
  close: number,
  supertrendValue: number,
  atrValue: number,
): number {
  if (!Number.isFinite(atrValue) || atrValue <= 0) return 0;
  return clamp(Math.abs(close - supertrendValue) / atrValue);
}

interface ConfidenceBreakdown {
  confidence: number;
  emaSpreadScore: number;
  rsiScore: number;
  supertrendScore: number;
}

function confidenceFor(
  context: StrategyMarketContext,
  configuration: MomentumScalpIndexStrategyConfiguration,
  indicators: ResolvedIndicators,
  side: TradeSide,
): ConfidenceBreakdown {
  const emaSpreadScore = clamp(Math.abs(indicators.emaFastValue - indicators.emaSlowValue) / indicators.atrValue);
  const rsiScore = rsiMomentumScore(indicators.rsiValue, side, configuration);
  const supertrendScore = supertrendBandScore(
    context.candle.close,
    indicators.supertrendValue,
    indicators.atrValue,
  );
  /*
   * 0.3 base + 0.3 EMA spread + 0.2 Supertrend headroom + 0.2 RSI position.
   *
   * The Supertrend term used to be folded into the base as a hardcoded 1.0 -- "implied as 1.0 since
   * we filtered it" -- which made the base 0.5. With `minimumConfidence: 0.5` that left the floor
   * **inert**: the smallest confidence the formula could return was exactly the threshold, so the
   * gate rejected nothing and the strategy advertised a confidence filter it did not have. Scoring
   * the headroom instead of assuming it restores a base of 0.3 and a floor that can actually bind.
   */
  const confidence = clamp(0.3 + emaSpreadScore * 0.3 + supertrendScore * 0.2 + rsiScore * 0.2);
  return { confidence, emaSpreadScore, rsiScore, supertrendScore };
}

function buildProposal(
  context: StrategyMarketContext,
  configuration: MomentumScalpIndexStrategyConfiguration,
  indicators: ResolvedIndicators,
  side: TradeSide,
): ProposedTradeIdea | null {
  const tickSize = context.candle.tickSize;
  if (!Number.isFinite(tickSize) || tickSize <= 0 || context.candle.close <= 0) return null;

  const barMilliseconds = timeframeMilliseconds(context.candle.timeframe);
  if (barMilliseconds === null) return null;

  const scores = confidenceFor(context, configuration, indicators, side);
  if (scores.confidence < configuration.minimumConfidence) return null;

  const entryPrice = roundNearestToTick(context.candle.close, tickSize);
  const rawStopDistance = Math.max(tickSize, indicators.atrValue * configuration.atrStopMultiple);
  const stopLoss = side === "LONG"
    ? roundDownToTick(entryPrice - rawStopDistance, tickSize)
    : roundUpToTick(entryPrice + rawStopDistance, tickSize);
  if (stopLoss <= 0 || (side === "LONG" && stopLoss >= entryPrice) || (side === "SHORT" && stopLoss <= entryPrice)) return null;

  const risk = Math.abs(entryPrice - stopLoss);
  const targetPrice = side === "LONG"
    ? roundUpToTick(entryPrice + risk * configuration.rewardRiskMultiple, tickSize)
    : roundDownToTick(entryPrice - risk * configuration.rewardRiskMultiple, tickSize);
  if (targetPrice <= 0 || (side === "LONG" && targetPrice <= entryPrice) || (side === "SHORT" && targetPrice >= entryPrice)) return null;

  const riskReward = rounded(Math.abs(targetPrice - entryPrice) / risk);
  const expiresAt = new Date(context.candle.closeTime.getTime() + barMilliseconds * configuration.expiryCandles);

  const evidenceItems: TradeIdeaEvidence[] = [
    {
      sourceType: "INDICATOR",
      sourceReference: `EMA:${indicators.emaFast.algorithmVersion}`,
      label: `Fast EMA ${indicators.emaFastValue.toFixed(2)} is ${side === "LONG" ? "above" : "below"} slow EMA ${indicators.emaSlowValue.toFixed(2)} by ${rounded(scores.emaSpreadScore)} ATR`,
      contribution: rounded(scores.emaSpreadScore * 0.3),
      details: {
        fast: indicators.emaFastValue,
        slow: indicators.emaSlowValue,
        spreadAtr: rounded(scores.emaSpreadScore),
        close: context.candle.close,
      },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `SUPERTREND:${indicators.supertrend.algorithmVersion}`,
      label: `Supertrend direction is ${indicators.supertrendTrend} with value `
        + `${indicators.supertrendValue.toFixed(2)}, leaving ${rounded(scores.supertrendScore)} ATR `
        + "of headroom before a flip",
      contribution: rounded(scores.supertrendScore * 0.2),
      details: {
        trend: indicators.supertrendTrend,
        value: indicators.supertrendValue,
        close: context.candle.close,
        headroomAtr: rounded(scores.supertrendScore),
      },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `RSI:${indicators.rsi.algorithmVersion}`,
      label: `RSI ${indicators.rsiValue.toFixed(2)} sits inside the ${side === "LONG" ? `${configuration.rsiLongMin}-${configuration.rsiLongMax}` : `${configuration.rsiShortMin}-${configuration.rsiShortMax}`} momentum band`,
      contribution: rounded(scores.rsiScore * 0.2),
      details: { value: indicators.rsiValue, close: context.candle.close },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `ATR:${indicators.atr.algorithmVersion}`,
      label: `ATR is ${indicators.atrValue.toFixed(2)}, setting a ${rounded(risk)} point stop distance`,
      contribution: null,
      details: { value: indicators.atrValue, stopDistance: rounded(risk) },
    },
    {
      sourceType: "STRATEGY" as const,
      sourceReference: `momentum-scalp-index:v${momentumScalpIndexStrategyVersion}`,
      label: `Momentum Scalp Index v${momentumScalpIndexStrategyVersion} rule set passed`,
      contribution: null,
      details: {
        configuration,
        sourceCandleId: context.candle.id,
        timeframe: context.candle.timeframe,
        entryPrice,
        stopLoss,
        targetPrice,
        riskReward,
        confidence: scores.confidence,
        confidenceTerms: {
          base: 0.3,
          emaSpread: rounded(scores.emaSpreadScore * 0.3),
          supertrendHeadroom: rounded(scores.supertrendScore * 0.2),
          rsiMomentum: rounded(scores.rsiScore * 0.2),
        },
        expiresAt: expiresAt.toISOString(),
      },
    },
  ];

  if (context.regime) {
    evidenceItems.push({
      sourceType: "REGIME" as const,
      sourceReference: "VIX_SMA20",
      label: `Volatility regime is ${context.regime.regime}`,
      contribution: null,
      details: {
        regime: context.regime.regime,
        valueRatio: rounded(context.regime.valueRatio),
      },
    });
  }

  const labelSide = side === "LONG" ? "BULLISH" : "BEARISH";
  return {
    side,
    entryPrice,
    stopLoss,
    targetPrice,
    riskReward,
    confidence: scores.confidence,
    reasoning: [
      `${labelSide} Momentum Scalp Index entry on ${context.candle.timeframe}.`,
      `Fast EMA is ${side === "LONG" ? "above" : "below"} slow EMA by ${rounded(scores.emaSpreadScore)} ATR, and Supertrend is ${indicators.supertrendTrend}.`,
      `RSI ${indicators.rsiValue.toFixed(2)} is inside the momentum band and short of the exhaustion edge.`,
      `Reference entry ${entryPrice.toFixed(2)}, stop ${stopLoss.toFixed(2)}, target ${targetPrice.toFixed(2)} (${riskReward.toFixed(2)}R).`,
    ],
    evidence: {
      strategy: "momentum-scalp-index",
      strategyVersion: momentumScalpIndexStrategyVersion,
      sourceCandleId: context.candle.id,
      sourceCandleClose: context.candle.close,
      indicatorAlgorithmVersion: configuration.indicatorAlgorithmVersion,
      candlestickAlgorithmVersion: configuration.candlestickAlgorithmVersion,
      priceActionAlgorithmVersion: configuration.priceActionAlgorithmVersion,
      regime: context.regime?.regime ?? null,
    },
    expiresAt,
    evidenceItems,
  };
}

export class MomentumScalpIndexStrategy {
  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const configuration = parseMomentumScalpIndexStrategyConfiguration(rawConfiguration);
    const indicators = resolveIndicators(context, configuration);
    if (!indicators) return [];

    const regime: VolatilityRegime | null = context.regime?.regime ?? null;
    if (configuration.requireRegime && regime === null) return [];

    const longConditions = indicators.supertrendTrend === "UP"
      && indicators.emaFastValue > indicators.emaSlowValue
      && indicators.rsiValue >= configuration.rsiLongMin
      && indicators.rsiValue <= configuration.rsiLongMax;

    if (longConditions) {
      const proposal = buildProposal(context, configuration, indicators, "LONG");
      if (proposal) return [proposal];
    }

    const shortConditions = indicators.supertrendTrend === "DOWN"
      && indicators.emaFastValue < indicators.emaSlowValue
      && indicators.rsiValue >= configuration.rsiShortMin
      && indicators.rsiValue <= configuration.rsiShortMax;

    if (shortConditions) {
      const proposal = buildProposal(context, configuration, indicators, "SHORT");
      if (proposal) return [proposal];
    }

    return [];
  }
}
