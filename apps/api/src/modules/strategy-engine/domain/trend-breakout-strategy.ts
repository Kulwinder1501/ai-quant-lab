import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";
import type {
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
  TradeSide,
} from "./strategy.js";
import type { VolatilityRegime } from "./regime.js";

export interface TrendBreakoutStrategyConfiguration {
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
  /**
   * Whether a measurable volatility regime is mandatory. When false the gate opens
   * if the regime is unknown, so a gap in the VIX series relaxes the rule set rather
   * than silently suppressing every proposal. Either answer is defensible, but it
   * must be a recorded part of the strategy version rather than an implicit default.
   */
  requireRegime: boolean;
  /**
   * Whether a same-candle candlestick pattern is mandatory, and whether a price-action trigger is.
   *
   * Both default **true**, which is the rule as it has always run -- these exist to make the
   * conjunction a measurable arm rather than to change it. Recorded on the strategy version for the
   * same reason `requireRegime` is: an implicit default would make two runs incomparable without
   * anything saying so.
   *
   * Loosening either is a research arm, not a tuning knob. The pre-registered sweep of 2026-09-02
   * established that `minimumConfidence` cannot raise the signal count because the scarcity lives in
   * this conjunction -- 55% of 60m bars carry a candlestick pattern and 40% a price-action event, so
   * requiring both is what makes the rule fire 0.04 times per session.
   *
   * At least one must remain required. With both absent the confidence formula tops out at
   * `0.38 + 0.1 = 0.48`, below any sane floor, so the rule would be indicators-only -- a different
   * strategy wearing this one's name and geometry.
   */
  requirePattern: boolean;
  requireTrigger: boolean;
}

export const defaultTrendBreakoutStrategyConfiguration: TrendBreakoutStrategyConfiguration = {
  indicatorAlgorithmVersion: "ta-v1",
  indicatorParameters: {
    EMA: { period: 20 },
    SMA: { period: 20 },
    RSI: { period: 14, smoothing: "WILDER" },
    MACD: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    ATR: { period: 14, smoothing: "WILDER" },
    SUPERTREND: { atrPeriod: 10, multiplier: 3 },
  },
  candlestickAlgorithmVersion: "candlestick-v1",
  priceActionAlgorithmVersion: "price-action-v2",
  rsiLongMin: 52,
  rsiLongMax: 70,
  rsiShortMin: 30,
  rsiShortMax: 48,
  atrStopMultiple: 1.5,
  rewardRiskMultiple: 2,
  minimumConfidence: 0.7,
  expiryCandles: 1,
  requireRegime: false,
  requirePattern: true,
  requireTrigger: true,
};

/** Single source of the version, so persisted evidence cannot drift from the registration. */
export const trendBreakoutStrategyVersion = 2;

export const trendBreakoutStrategyRegistration = {
  strategyKey: "trend-breakout",
  name: "Trend Breakout",
  description: "Completed-candle breakout continuation with trend, momentum, candlestick confirmation, and volatility regime gating.",
  version: trendBreakoutStrategyVersion,
  configuration: { ...defaultTrendBreakoutStrategyConfiguration } as Record<string, unknown>,
};

type IndicatorSnapshot = StrategyMarketContext["indicators"][number];
type PatternEvidence = StrategyMarketContext["patterns"][number];
type PriceActionEvidence = StrategyMarketContext["priceActionEvents"][number];

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function indicatorNumber(values: IndicatorValues, key: string): number | null {
  return asFiniteNumber(values[key]);
}

function indicatorText(values: IndicatorValues, key: string): string | null {
  const value = values[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function findIndicator(
  context: StrategyMarketContext,
  code: IndicatorCode,
  algorithmVersion: string,
  parameters: Record<string, number | string | boolean>,
): IndicatorSnapshot | null {
  const expectedParameters = stableJson(parameters);
  return context.indicators.find((indicator) => (
    indicator.code === code
    && indicator.algorithmVersion === algorithmVersion
    && stableJson(indicator.parameters) === expectedParameters
  )) ?? null;
}

function strongest<T extends { confidence: number }>(candidates: readonly T[]): T | null {
  return candidates.reduce<T | null>((best, candidate) => !best || candidate.confidence > best.confidence ? candidate : best, null);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function roundNearestToTick(value: number, tickSize: number): number {
  return rounded(Math.round(value / tickSize) * tickSize);
}

function roundDownToTick(value: number, tickSize: number): number {
  return rounded(Math.floor((value + Number.EPSILON) / tickSize) * tickSize);
}

function roundUpToTick(value: number, tickSize: number): number {
  return rounded(Math.ceil((value - Number.EPSILON) / tickSize) * tickSize);
}

function timeframeMilliseconds(timeframe: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe);
  if (!match) {
    throw new Error(`Cannot derive an expiry for unsupported timeframe ${timeframe}.`);
  }
  const count = Number(match[1]);
  const unitMilliseconds = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return count * unitMilliseconds;
}

function requiredString(raw: Record<string, unknown>, key: keyof TrendBreakoutStrategyConfiguration): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Trend breakout configuration requires a non-empty ${key}.`);
  }
  return value;
}

function requiredNumber(raw: Record<string, unknown>, key: keyof TrendBreakoutStrategyConfiguration, minimum: number, maximum = Number.POSITIVE_INFINITY): number {
  const value = asFiniteNumber(raw[key]);
  if (value === null || value < minimum || value > maximum) {
    throw new Error(`Trend breakout configuration has invalid ${key}.`);
  }
  return value;
}

function requiredBoolean(raw: Record<string, unknown>, key: keyof TrendBreakoutStrategyConfiguration): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") {
    throw new Error(`Trend breakout configuration requires a boolean ${key}.`);
  }
  return value;
}

function requiredIndicatorParameters(raw: Record<string, unknown>): Record<string, Record<string, number | string | boolean>> {
  const candidate = raw.indicatorParameters;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Trend breakout configuration requires indicator parameter sets.");
  }
  const result: Record<string, Record<string, number | string | boolean>> = {};
  for (const code of ["EMA", "SMA", "RSI", "MACD", "ATR", "SUPERTREND"]) {
    const parameters = (candidate as Record<string, unknown>)[code];
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length === 0) {
      throw new Error(`Trend breakout configuration requires parameters for ${code}.`);
    }
    const typed: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
        throw new Error(`Trend breakout configuration has an unsupported parameter for ${code}.`);
      }
      typed[key] = value;
    }
    result[code] = typed;
  }
  return result;
}

/** Parses stored configuration strictly so a strategy version is fully reproducible. */
export function parseTrendBreakoutStrategyConfiguration(raw: Record<string, unknown>): TrendBreakoutStrategyConfiguration {
  const configuration: TrendBreakoutStrategyConfiguration = {
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
    /*
     * Defaulted rather than required, unlike every sibling: stored registrations predate these
     * fields, and `requiredBoolean` would throw on all of them. Absent must mean the historical
     * behaviour -- both required -- or adding a research lever would retroactively invalidate every
     * configuration already on disk.
     */
    requirePattern: optionalBoolean(raw, "requirePattern", true),
    requireTrigger: optionalBoolean(raw, "requireTrigger", true),
  };
  if (!Number.isInteger(configuration.expiryCandles)
    || configuration.rsiLongMin >= configuration.rsiLongMax
    || configuration.rsiShortMin >= configuration.rsiShortMax) {
    throw new Error("Trend breakout configuration has invalid ranges.");
  }
  return configuration;
}

interface ResolvedIndicators {
  ema: IndicatorSnapshot;
  sma: IndicatorSnapshot;
  rsi: IndicatorSnapshot;
  macd: IndicatorSnapshot;
  atr: IndicatorSnapshot;
  supertrend: IndicatorSnapshot;
  emaValue: number;
  smaValue: number;
  rsiValue: number;
  macdHistogram: number;
  atrValue: number;
  supertrendTrend: string;
}

function resolveIndicators(context: StrategyMarketContext, configuration: TrendBreakoutStrategyConfiguration): ResolvedIndicators | null {
  const ema = findIndicator(context, "EMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.EMA);
  const sma = findIndicator(context, "SMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.SMA);
  const rsi = findIndicator(context, "RSI", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.RSI);
  const macd = findIndicator(context, "MACD", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.MACD);
  const atr = findIndicator(context, "ATR", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.ATR);
  const supertrend = findIndicator(context, "SUPERTREND", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.SUPERTREND);
  if (!ema || !sma || !rsi || !macd || !atr || !supertrend) return null;

  const emaValue = indicatorNumber(ema.values, "value");
  const smaValue = indicatorNumber(sma.values, "value");
  const rsiValue = indicatorNumber(rsi.values, "value");
  const macdHistogram = indicatorNumber(macd.values, "histogram");
  const atrValue = indicatorNumber(atr.values, "value");
  const supertrendTrend = indicatorText(supertrend.values, "trend");
  if (emaValue === null || smaValue === null || rsiValue === null || macdHistogram === null
    || atrValue === null || atrValue <= 0 || !supertrendTrend) return null;
  return { ema, sma, rsi, macd, atr, supertrend, emaValue, smaValue, rsiValue, macdHistogram, atrValue, supertrendTrend };
}

function selectedPattern(context: StrategyMarketContext, direction: "BULLISH" | "BEARISH", configuration: TrendBreakoutStrategyConfiguration): PatternEvidence | null {
  return strongest(context.patterns.filter((pattern) => (
    pattern.algorithmVersion === configuration.candlestickAlgorithmVersion && pattern.direction === direction
  )));
}

function selectedTrigger(
  context: StrategyMarketContext,
  eventCode: "BREAKOUT" | "BREAKDOWN",
  direction: "BULLISH" | "BEARISH",
  configuration: TrendBreakoutStrategyConfiguration,
): PriceActionEvidence | null {
  return strongest(context.priceActionEvents.filter((event) => (
    event.algorithmVersion === configuration.priceActionAlgorithmVersion
    && event.eventCode === eventCode
    && event.direction === direction
  )));
}

function evidenceForIndicators(indicators: ResolvedIndicators, side: TradeSide): TradeIdeaEvidence[] {
  const favorable = side === "LONG" ? "above" : "below";
  const momentum = side === "LONG" ? "positive" : "negative";
  const trend = side === "LONG" ? "UP" : "DOWN";
  return [
    { sourceType: "INDICATOR", sourceReference: `EMA:${indicators.ema.algorithmVersion}`, label: `Close is ${favorable} EMA`, contribution: 0.08, details: { close: null, ema: indicators.emaValue } },
    { sourceType: "INDICATOR", sourceReference: `SMA:${indicators.sma.algorithmVersion}`, label: `Close is ${favorable} SMA`, contribution: 0.08, details: { close: null, sma: indicators.smaValue } },
    { sourceType: "INDICATOR", sourceReference: `RSI:${indicators.rsi.algorithmVersion}`, label: "RSI is inside the strategy momentum range", contribution: 0.08, details: { rsi: indicators.rsiValue } },
    { sourceType: "INDICATOR", sourceReference: `MACD:${indicators.macd.algorithmVersion}`, label: `MACD histogram is ${momentum}`, contribution: 0.08, details: { histogram: indicators.macdHistogram } },
    { sourceType: "INDICATOR", sourceReference: `SUPERTREND:${indicators.supertrend.algorithmVersion}`, label: `Supertrend is ${trend}`, contribution: 0.08, details: { trend: indicators.supertrendTrend } },
    { sourceType: "INDICATOR", sourceReference: `ATR:${indicators.atr.algorithmVersion}`, label: "ATR determines the protective stop distance", contribution: null, details: { atr: indicators.atrValue } },
  ];
}

/** Gates a side on the measured regime, or on configuration when it is unknown. */
function regimePermits(
  context: StrategyMarketContext,
  configuration: TrendBreakoutStrategyConfiguration,
  permitted: VolatilityRegime,
): boolean {
  if (!context.regime) return !configuration.requireRegime;
  return context.regime.regime === permitted;
}

function optionalBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`Trend breakout configuration requires a boolean ${key} when present.`);
  }
  return value;
}

function buildProposal(
  context: StrategyMarketContext,
  configuration: TrendBreakoutStrategyConfiguration,
  indicators: ResolvedIndicators,
  side: TradeSide,
  pattern: PatternEvidence | null,
  trigger: PriceActionEvidence | null,
): ProposedTradeIdea | null {
  if (!pattern && !trigger) {
    // Guarded here as well as in the config: indicators-only is a different strategy, and the
    // confidence formula would top out at 0.48 anyway.
    throw new Error("A trend-breakout proposal needs at least one of a pattern or a trigger.");
  }
  const tickSize = context.candle.tickSize;
  if (!Number.isFinite(tickSize) || tickSize <= 0 || context.candle.close <= 0) return null;

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
  const distanceFromEma = Math.min(1, Math.abs(context.candle.close - indicators.emaValue) / indicators.atrValue);
  /*
   * A missing term contributes zero rather than being imputed.
   *
   * The alternative -- rescaling the remaining weights so the formula still spans 1.0 -- would make a
   * looser arm's confidence incomparable with the control's, and the whole point of the arm is to
   * compare them. So a trigger-only signal tops out at 0.78 and a pattern-only one at 0.70, and both
   * are still judged against the same `minimumConfidence`.
   *
   * Zero is honest here specifically because absence is measured: the replay reads stored contexts
   * where the detectors have run, and 55% of 60m bars carry a pattern. Where a layer had NOT been
   * computed, zero would be an imputation and this would be wrong -- see the deferral taxonomy, which
   * exists to keep "computed and empty" apart from "not computed".
   */
  const confidence = clamp(
    0.38
    + (trigger?.confidence ?? 0) * 0.3
    + (pattern?.confidence ?? 0) * 0.22
    + distanceFromEma * 0.1,
  );
  if (confidence < configuration.minimumConfidence) return null;

  const labelSide = side === "LONG" ? "bullish" : "bearish";
  const expiresAt = new Date(context.candle.closeTime.getTime() + timeframeMilliseconds(context.candle.timeframe) * configuration.expiryCandles);
  const evidenceItems: TradeIdeaEvidence[] = [
    ...evidenceForIndicators(indicators, side).map((item) => ({
      ...item,
      details: { ...item.details, close: context.candle.close },
    })),
    /*
     * Omitted when absent rather than recorded as an empty or zero-confidence item.
     *
     * An evidence list is a claim about what was actually read. A PATTERN row with confidence 0
     * would assert the detector looked and found nothing of value, which is a different statement
     * from "this arm did not require one" -- and the evidence list is what a reviewer reads back.
     */
    ...(pattern === null ? [] : [{
      sourceType: "PATTERN" as const,
      sourceReference: `${pattern.code}:${pattern.algorithmVersion}`,
      label: `${pattern.code} provides ${labelSide} candlestick confirmation`,
      contribution: rounded(pattern.confidence * 0.22),
      details: { confidence: pattern.confidence, contextCandleIds: pattern.contextCandleIds, ...pattern.details },
    }]),
    ...(trigger === null ? [] : [{
      sourceType: "PRICE_ACTION" as const,
      sourceReference: `${trigger.eventCode}:${trigger.algorithmVersion}`,
      label: `${trigger.eventCode} is the ${labelSide} entry trigger`,
      contribution: rounded(trigger.confidence * 0.3),
      details: { confidence: trigger.confidence, level: trigger.level, ...trigger.details },
    }]),
    {
      sourceType: "STRATEGY" as const,
      sourceReference: `trend-breakout:v${trendBreakoutStrategyVersion}`,
      label: `Trend Breakout v${trendBreakoutStrategyVersion} rule set passed at candle close`,
      contribution: null,
      details: {
        configuration,
        sourceCandleId: context.candle.id,
        timeframe: context.candle.timeframe,
        entryPrice,
        stopLoss,
        targetPrice,
        riskReward,
        confidence,
        expiresAt: expiresAt.toISOString(),
      },
    },
  ];

  if (context.regime) {
    evidenceItems.push({
      sourceType: "REGIME" as const,
      sourceReference: "VIX_SMA20",
      label: `Volatility regime is ${context.regime.regime}`,
      // The regime is a gate, not a term in the confidence formula. Claiming a
      // numeric contribution here would over-attribute the computed confidence.
      contribution: null,
      details: {
        regime: context.regime.regime,
        valueRatio: rounded(context.regime.valueRatio),
      },
    });
  }

  return {
    side,
    entryPrice,
    stopLoss,
    targetPrice,
    riskReward,
    confidence,
    reasoning: [
      trigger === null
        // Says what is absent, not nothing: a reader must not have to infer which arm produced this.
        ? `Completed-candle ${labelSide} EMA, SMA, MACD, RSI and Supertrend conditions aligned with no price-action trigger required.`
        : `Completed-candle ${trigger.eventCode.toLowerCase()} aligns with ${labelSide} EMA, SMA, MACD, RSI, and Supertrend conditions.`,
      pattern === null
        ? "No same-candle candlestick confirmation was required by this configuration."
        : `${pattern.code} supplies same-candle ${labelSide} candlestick confirmation.`,
      `Reference entry ${entryPrice.toFixed(2)}, stop ${stopLoss.toFixed(2)}, target ${targetPrice.toFixed(2)} (${riskReward.toFixed(2)}R).`,
      "This is a close-time paper-trade proposal only; a later phase simulates an eligible next-candle fill.",
    ],
    evidence: {
      strategy: "trend-breakout",
      strategyVersion: trendBreakoutStrategyVersion,
      sourceCandleId: context.candle.id,
      sourceCandleClose: context.candle.close,
      trigger: trigger?.eventCode ?? null,
      pattern: pattern?.code ?? null,
      // The arm, recorded on every proposal: a loosened row must never be mistaken for a control row.
      requirePattern: configuration.requirePattern,
      requireTrigger: configuration.requireTrigger,
      indicatorAlgorithmVersion: configuration.indicatorAlgorithmVersion,
      candlestickAlgorithmVersion: configuration.candlestickAlgorithmVersion,
      priceActionAlgorithmVersion: configuration.priceActionAlgorithmVersion,
      regime: context.regime?.regime ?? null,
    },
    expiresAt,
    evidenceItems,
  };
}

/**
 * Deterministic, close-time strategy evaluation. It produces proposals only when
 * technical indicators, candlestick evidence, and a price-action trigger agree.
 */
export class TrendBreakoutStrategy {
  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const configuration = parseTrendBreakoutStrategyConfiguration(rawConfiguration);
    const indicators = resolveIndicators(context, configuration);
    if (!indicators) return [];

    const longConditions = regimePermits(context, configuration, "LOW_VOL")
      && context.candle.close > indicators.emaValue
      && context.candle.close > indicators.smaValue
      && indicators.rsiValue >= configuration.rsiLongMin
      && indicators.rsiValue <= configuration.rsiLongMax
      && indicators.macdHistogram > 0
      && indicators.supertrendTrend === "UP";
    if (longConditions) {
      const pattern = selectedPattern(context, "BULLISH", configuration);
      const trigger = selectedTrigger(context, "BREAKOUT", "BULLISH", configuration);
      /*
       * Each piece of evidence is needed if its flag says so, and at least one must be present.
       * With both flags false and both absent the rule would be indicators-only, so the second
       * clause is what keeps a loosened arm a variant of this strategy rather than a new one.
       */
      if ((pattern || !configuration.requirePattern)
        && (trigger || !configuration.requireTrigger)
        && (pattern || trigger)) {
        const proposal = buildProposal(context, configuration, indicators, "LONG", pattern, trigger);
        if (proposal) return [proposal];
      }
    }

    const shortConditions = regimePermits(context, configuration, "HIGH_VOL")
      && context.candle.close < indicators.emaValue
      && context.candle.close < indicators.smaValue
      && indicators.rsiValue >= configuration.rsiShortMin
      && indicators.rsiValue <= configuration.rsiShortMax
      && indicators.macdHistogram < 0
      && indicators.supertrendTrend === "DOWN";
    if (shortConditions) {
      const pattern = selectedPattern(context, "BEARISH", configuration);
      const trigger = selectedTrigger(context, "BREAKDOWN", "BEARISH", configuration);
      if ((pattern || !configuration.requirePattern)
        && (trigger || !configuration.requireTrigger)
        && (pattern || trigger)) {
        const proposal = buildProposal(context, configuration, indicators, "SHORT", pattern, trigger);
        if (proposal) return [proposal];
      }
    }
    return [];
  }
}
