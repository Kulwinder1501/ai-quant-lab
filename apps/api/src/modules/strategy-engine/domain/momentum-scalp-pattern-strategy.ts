import { createHash } from "node:crypto";
import {
  type ProposedTradeIdea,
  type StrategyMarketContext,
  type TradeIdeaEvidence,
  type TradeSide,
} from "./strategy.js";
import { type CandlestickPatternCode, type PriceActionEventCode } from "../../pattern-recognition/domain/market-pattern.js";
import {
  calculateHtfSrConfluence,
  calculateHtfTrendAlignment,
} from "./multi-timeframe-confluence.js";

function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== "object") {
    if (typeof val === "number" && (!Number.isFinite(val) || Number.isNaN(val))) {
      return null;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const res: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    if (obj[k] !== undefined && typeof obj[k] !== "function") {
      res[k] = canonicalize(obj[k]);
    }
  }
  return res;
}

export function computeConfigurationHash(effectiveConfig: Record<string, unknown>): string {
  const canonical = canonicalize(effectiveConfig);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

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

export const momentumScalpPatternStrategyVersion = 1;

export interface MomentumScalpPatternStrategyConfiguration {
  indicatorAlgorithmVersion: string;
  candlestickAlgorithmVersion: string;
  priceActionAlgorithmVersion: string;
  scoreThreshold: number;
  atrStopMultiple: number;
  rewardRiskMultiple: number;
  maxSrDistanceAtr: number;
  volumeSurgeRatio: number;
  expiryCandles: number;
}

export const defaultMomentumScalpPatternStrategyConfiguration: MomentumScalpPatternStrategyConfiguration = {
  indicatorAlgorithmVersion: "ta-v1",
  candlestickAlgorithmVersion: "candlestick-v1",
  priceActionAlgorithmVersion: "price-action-v2",
  scoreThreshold: 5,
  atrStopMultiple: 1.0,
  rewardRiskMultiple: 1.5,
  maxSrDistanceAtr: 1.5,
  volumeSurgeRatio: 1.1,
  expiryCandles: 3,
};

export const momentumScalpPatternStrategyRegistration = {
  strategyKey: "momentum-scalp-pattern",
  name: "Momentum Scalp (Pattern Confluence)",
  description: "Scored market context (Trend, VWAP, S/R, Volume) triggered by confirming candlestick patterns.",
  version: momentumScalpPatternStrategyVersion,
  configuration: { ...defaultMomentumScalpPatternStrategyConfiguration } as Record<string, unknown>,
};

const BULLISH_PATTERNS: readonly CandlestickPatternCode[] = [
  "HAMMER",
  "INVERTED_HAMMER",
  "BULLISH_ENGULFING",
  "PIERCING_LINE",
  "TWEEZER_BOTTOM",
  "MORNING_STAR",
  "BULLISH_HARAMI",
  "THREE_WHITE_SOLDIERS",
  "BULLISH_MARUBOZU",
  "THREE_INSIDE_UP",
  "DRAGONFLY_DOJI",
];

const BEARISH_PATTERNS: readonly CandlestickPatternCode[] = [
  "SHOOTING_STAR",
  "BEARISH_ENGULFING",
  "DARK_CLOUD_COVER",
  "TWEEZER_TOP",
  "EVENING_STAR",
  "BEARISH_HARAMI",
  "THREE_BLACK_CROWS",
  "BEARISH_MARUBOZU",
  "THREE_INSIDE_DOWN",
  "GRAVESTONE_DOJI",
  "HANGING_MAN",
];

function findIndicator(
  indicators: StrategyMarketContext["indicators"],
  code: string,
  algorithmVersion: string,
): IndicatorSnapshot | undefined {
  return indicators.find((ind) => ind.code === code && ind.algorithmVersion === algorithmVersion);
}

function parseConfig(raw: Record<string, unknown>): MomentumScalpPatternStrategyConfiguration {
  return {
    indicatorAlgorithmVersion: typeof raw.indicatorAlgorithmVersion === "string" ? raw.indicatorAlgorithmVersion : defaultMomentumScalpPatternStrategyConfiguration.indicatorAlgorithmVersion,
    candlestickAlgorithmVersion: typeof raw.candlestickAlgorithmVersion === "string" ? raw.candlestickAlgorithmVersion : defaultMomentumScalpPatternStrategyConfiguration.candlestickAlgorithmVersion,
    priceActionAlgorithmVersion: typeof raw.priceActionAlgorithmVersion === "string" ? raw.priceActionAlgorithmVersion : defaultMomentumScalpPatternStrategyConfiguration.priceActionAlgorithmVersion,
    scoreThreshold: typeof raw.scoreThreshold === "number" ? raw.scoreThreshold : defaultMomentumScalpPatternStrategyConfiguration.scoreThreshold,
    atrStopMultiple: typeof raw.atrStopMultiple === "number" ? raw.atrStopMultiple : defaultMomentumScalpPatternStrategyConfiguration.atrStopMultiple,
    rewardRiskMultiple: typeof raw.rewardRiskMultiple === "number" ? raw.rewardRiskMultiple : defaultMomentumScalpPatternStrategyConfiguration.rewardRiskMultiple,
    maxSrDistanceAtr: typeof raw.maxSrDistanceAtr === "number" ? raw.maxSrDistanceAtr : defaultMomentumScalpPatternStrategyConfiguration.maxSrDistanceAtr,
    volumeSurgeRatio: typeof raw.volumeSurgeRatio === "number" ? raw.volumeSurgeRatio : defaultMomentumScalpPatternStrategyConfiguration.volumeSurgeRatio,
    expiryCandles: typeof raw.expiryCandles === "number" ? raw.expiryCandles : defaultMomentumScalpPatternStrategyConfiguration.expiryCandles,
  };
}

export class MomentumScalpPatternStrategy {
  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const config = parseConfig(rawConfiguration);
    const { candle } = context;
    const tickSize = candle.tickSize > 0 ? candle.tickSize : 0.05;

    const atrInd = findIndicator(context.indicators, "ATR", config.indicatorAlgorithmVersion);
    const atr = typeof atrInd?.values.value === "number" && Number.isFinite(atrInd.values.value) ? atrInd.values.value : 0;
    if (atr <= 0) return [];

    const vwapInd = findIndicator(context.indicators, "VWAP", config.indicatorAlgorithmVersion);
    const vwap = typeof vwapInd?.values.value === "number" && Number.isFinite(vwapInd.values.value) ? vwapInd.values.value : null;

    const supertrendInd = findIndicator(context.indicators, "SUPERTREND", config.indicatorAlgorithmVersion);
    const supertrend = typeof supertrendInd?.values.value === "number" ? supertrendInd.values.value : null;
    const supertrendTrend = typeof supertrendInd?.values.trend === "string" ? supertrendInd.values.trend.toUpperCase() : null;

    const emaFastInd = findIndicator(context.indicators, "EMA", config.indicatorAlgorithmVersion);
    const emaFast = typeof emaFastInd?.values.value === "number" ? emaFastInd.values.value : null;

    // Price action support / resistance levels
    const supportEvents = context.priceActionEvents.filter(
      (e) => e.eventCode === "SUPPORT" && e.level !== null && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );
    const resistanceEvents = context.priceActionEvents.filter(
      (e) => e.eventCode === "RESISTANCE" && e.level !== null && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );

    const nearestSupportDistanceAtr = supportEvents.length > 0
      ? Math.min(...supportEvents.map((e) => Math.abs(candle.close - (e.level ?? candle.close)) / atr))
      : Infinity;

    const nearestResistanceDistanceAtr = resistanceEvents.length > 0
      ? Math.min(...resistanceEvents.map((e) => Math.abs((e.level ?? candle.close) - candle.close) / atr))
      : Infinity;

    // Candlestick pattern detections on current candle
    const patterns = context.patterns.filter(
      (p) => p.algorithmVersion === config.candlestickAlgorithmVersion,
    );

    const proposals: ProposedTradeIdea[] = [];

    // Evaluate LONG side
    const bullishPattern = patterns.find((p) => BULLISH_PATTERNS.includes(p.code) && p.direction === "BULLISH");
    if (bullishPattern) {
      let longScore = 0;
      const evidence: TradeIdeaEvidence[] = [];

      // 1. Trend confirmation (+2)
      const trendBullish = (supertrendTrend === "UP" || (supertrend !== null && candle.close > supertrend))
        || (emaFast !== null && candle.close > emaFast);
      if (trendBullish) {
        longScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "SUPERTREND/EMA",
          label: "Uptrend alignment",
          contribution: 0.28,
          details: { supertrend, supertrendTrend, emaFast },
        });
      }

      // 2. VWAP confluence (+2)
      if (vwap !== null && candle.close >= vwap - 0.5 * atr) {
        longScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VWAP",
          label: "Price above or bouncing at VWAP",
          contribution: 0.28,
          details: { vwap, close: candle.close },
        });
      }

      // 3. Support proximity (+2)
      if (nearestSupportDistanceAtr <= config.maxSrDistanceAtr) {
        longScore += 2;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "SUPPORT",
          label: "Near support level",
          contribution: 0.28,
          details: { nearestSupportDistanceAtr },
        });
      }

      // 4. Volume Surge (+1)
      if (candle.volume > 0) {
        longScore += 1;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VOLUME",
          label: "Volume participation",
          contribution: 0.14,
          details: { volume: candle.volume },
        });
      }

      // 5. Higher-Timeframe Confluence (+1 trend, +1 S/R, -1 disagreement)
      const htfTrendScore = calculateHtfTrendAlignment("BULLISH", context.higherTimeframes);
      const htfSrScore = calculateHtfSrConfluence(candle.close, "BULLISH", atr, context.higherTimeframes, config.maxSrDistanceAtr);
      const htfTotalScore = htfTrendScore + htfSrScore;
      if (htfTotalScore !== 0) {
        longScore += htfTotalScore;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "HTF_CONFLUENCE",
          label: `Higher-timeframe confluence (${htfTotalScore > 0 ? "+" : ""}${htfTotalScore})`,
          contribution: rounded(htfTotalScore * 0.14),
          details: { htfTrendScore, htfSrScore, higherTimeframes: context.higherTimeframes },
        });
      }

      if (longScore >= config.scoreThreshold) {
        evidence.push({
          sourceType: "PATTERN",
          sourceReference: bullishPattern.code,
          label: `Trigger: ${bullishPattern.code}`,
          contribution: 0.35,
          details: { pattern: bullishPattern.code, confidence: bullishPattern.confidence },
        });

        const entryPrice = candle.close;
        const stopLoss = roundDownToTick(entryPrice - atr * config.atrStopMultiple, tickSize);
        const risk = entryPrice - stopLoss;
        const targetPrice = roundNearestToTick(entryPrice + risk * config.rewardRiskMultiple, tickSize);

        if (stopLoss < entryPrice && targetPrice > entryPrice && risk > 0) {
          const confidenceScore = clamp((longScore / 9) * 0.6 + bullishPattern.confidence * 0.4);
          const expiryMs = timeframeMilliseconds(candle.timeframe);
          const expiresAt = expiryMs ? new Date(candle.closeTime.getTime() + expiryMs * config.expiryCandles) : null;

          proposals.push({
            side: "LONG",
            entryPrice,
            stopLoss,
            targetPrice,
            riskReward: rounded((targetPrice - entryPrice) / risk),
            confidence: rounded(confidenceScore),
            reasoning: [
              `Context Score: ${longScore}/9 with ${bullishPattern.code} trigger.`,
              `Entry at ${entryPrice}, SL at ${stopLoss} (-${rounded(risk)}), Target at ${targetPrice} (+${rounded(targetPrice - entryPrice)}).`,
            ],
            evidence: { score: longScore, maxScore: 9, pattern: bullishPattern.code },
            evidenceItems: evidence,
            expiresAt,
          });
        }
      }
    }

    // Evaluate SHORT side (symmetrical)
    const bearishPattern = patterns.find((p) => BEARISH_PATTERNS.includes(p.code) && p.direction === "BEARISH");
    if (bearishPattern) {
      let shortScore = 0;
      const evidence: TradeIdeaEvidence[] = [];

      // 1. Trend confirmation (+2)
      const trendBearish = (supertrendTrend === "DOWN" || (supertrend !== null && candle.close < supertrend))
        || (emaFast !== null && candle.close < emaFast);
      if (trendBearish) {
        shortScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "SUPERTREND/EMA",
          label: "Downtrend alignment",
          contribution: 0.28,
          details: { supertrend, supertrendTrend, emaFast },
        });
      }

      // 2. VWAP confluence (+2)
      if (vwap !== null && candle.close <= vwap + 0.5 * atr) {
        shortScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VWAP",
          label: "Price below or rejecting at VWAP",
          contribution: 0.28,
          details: { vwap, close: candle.close },
        });
      }

      // 3. Resistance proximity (+2)
      if (nearestResistanceDistanceAtr <= config.maxSrDistanceAtr) {
        shortScore += 2;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "RESISTANCE",
          label: "Near resistance level",
          contribution: 0.28,
          details: { nearestResistanceDistanceAtr },
        });
      }

      // 4. Volume Surge (+1)
      if (candle.volume > 0) {
        shortScore += 1;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VOLUME",
          label: "Volume participation",
          contribution: 0.14,
          details: { volume: candle.volume },
        });
      }

      // 5. Higher-Timeframe Confluence (+1 trend, +1 S/R, -1 disagreement)
      const htfTrendScore = calculateHtfTrendAlignment("BEARISH", context.higherTimeframes);
      const htfSrScore = calculateHtfSrConfluence(candle.close, "BEARISH", atr, context.higherTimeframes, config.maxSrDistanceAtr);
      const htfTotalScore = htfTrendScore + htfSrScore;
      if (htfTotalScore !== 0) {
        shortScore += htfTotalScore;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "HTF_CONFLUENCE",
          label: `Higher-timeframe confluence (${htfTotalScore > 0 ? "+" : ""}${htfTotalScore})`,
          contribution: rounded(htfTotalScore * 0.14),
          details: { htfTrendScore, htfSrScore, higherTimeframes: context.higherTimeframes },
        });
      }

      if (shortScore >= config.scoreThreshold) {
        evidence.push({
          sourceType: "PATTERN",
          sourceReference: bearishPattern.code,
          label: `Trigger: ${bearishPattern.code}`,
          contribution: 0.35,
          details: { pattern: bearishPattern.code, confidence: bearishPattern.confidence },
        });

        const entryPrice = candle.close;
        const stopLoss = roundUpToTick(entryPrice + atr * config.atrStopMultiple, tickSize);
        const risk = stopLoss - entryPrice;
        const targetPrice = roundNearestToTick(entryPrice - risk * config.rewardRiskMultiple, tickSize);

        if (stopLoss > entryPrice && targetPrice < entryPrice && risk > 0) {
          const confidenceScore = clamp((shortScore / 9) * 0.6 + bearishPattern.confidence * 0.4);
          const expiryMs = timeframeMilliseconds(candle.timeframe);
          const expiresAt = expiryMs ? new Date(candle.closeTime.getTime() + expiryMs * config.expiryCandles) : null;

          proposals.push({
            side: "SHORT",
            entryPrice,
            stopLoss,
            targetPrice,
            riskReward: rounded((entryPrice - targetPrice) / risk),
            confidence: rounded(confidenceScore),
            reasoning: [
              `Context Score: ${shortScore}/9 with ${bearishPattern.code} trigger.`,
              `Entry at ${entryPrice}, SL at ${stopLoss} (+${rounded(risk)}), Target at ${targetPrice} (-${rounded(entryPrice - targetPrice)}).`,
            ],
            evidence: { score: shortScore, maxScore: 9, pattern: bearishPattern.code },
            evidenceItems: evidence,
            expiresAt,
          });
        }
      }
    }

    return proposals;
  }
}

export const momentumScalpPatternStrategyV2Version = 2;

export const momentumScalpPatternStrategyV2Registration = {
  strategyKey: "momentum-scalp-pattern-v2",
  name: "Momentum Scalp v2 (Pattern Confluence)",
  description: "Enhanced pattern confluence with pure geometric Inverted Hammer, Head & Shoulders, Wedges, and 4-layer configuration versioning.",
  version: momentumScalpPatternStrategyV2Version,
  configuration: { ...defaultMomentumScalpPatternStrategyConfiguration } as Record<string, unknown>,
};

const BULLISH_CHART_PATTERNS: readonly PriceActionEventCode[] = [
  "DOUBLE_BOTTOM",
  "BULL_FLAG",
  "ASCENDING_TRIANGLE",
  "INVERSE_HEAD_AND_SHOULDERS",
  "FALLING_WEDGE",
];

const BEARISH_CHART_PATTERNS: readonly PriceActionEventCode[] = [
  "DOUBLE_TOP",
  "BEAR_FLAG",
  "DESCENDING_TRIANGLE",
  "HEAD_AND_SHOULDERS",
  "RISING_WEDGE",
];

export class MomentumScalpPatternStrategyV2 {
  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const config = parseConfig(rawConfiguration);
    const configurationHash = computeConfigurationHash(config as unknown as Record<string, unknown>);
    const { candle } = context;
    const tickSize = candle.tickSize > 0 ? candle.tickSize : 0.05;

    const atrInd = findIndicator(context.indicators, "ATR", config.indicatorAlgorithmVersion);
    const atr = typeof atrInd?.values.value === "number" && Number.isFinite(atrInd.values.value) ? atrInd.values.value : 0;
    if (atr <= 0) return [];

    const vwapInd = findIndicator(context.indicators, "VWAP", config.indicatorAlgorithmVersion);
    const vwap = typeof vwapInd?.values.value === "number" && Number.isFinite(vwapInd.values.value) ? vwapInd.values.value : null;

    const supertrendInd = findIndicator(context.indicators, "SUPERTREND", config.indicatorAlgorithmVersion);
    const supertrend = typeof supertrendInd?.values.value === "number" ? supertrendInd.values.value : null;
    const supertrendTrend = typeof supertrendInd?.values.trend === "string" ? supertrendInd.values.trend.toUpperCase() : null;

    const emaFastInd = findIndicator(context.indicators, "EMA", config.indicatorAlgorithmVersion);
    const emaFast = typeof emaFastInd?.values.value === "number" ? emaFastInd.values.value : null;

    // Price action support / resistance levels
    const supportEvents = context.priceActionEvents.filter(
      (e) => e.eventCode === "SUPPORT" && e.level !== null && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );
    const resistanceEvents = context.priceActionEvents.filter(
      (e) => e.eventCode === "RESISTANCE" && e.level !== null && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );

    const nearestSupportDistanceAtr = supportEvents.length > 0
      ? Math.min(...supportEvents.map((e) => Math.abs(candle.close - (e.level ?? candle.close)) / atr))
      : Infinity;

    const nearestResistanceDistanceAtr = resistanceEvents.length > 0
      ? Math.min(...resistanceEvents.map((e) => Math.abs((e.level ?? candle.close) - candle.close) / atr))
      : Infinity;

    // Candlestick pattern detections on current candle
    const patterns = context.patterns.filter(
      (p) => p.algorithmVersion === config.candlestickAlgorithmVersion,
    );

    const proposals: ProposedTradeIdea[] = [];

    // Macro Chart Pattern confluence
    const bullishChartPattern = context.priceActionEvents.find(
      (e) => BULLISH_CHART_PATTERNS.includes(e.eventCode) && e.direction === "BULLISH" && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );
    const bearishChartPattern = context.priceActionEvents.find(
      (e) => BEARISH_CHART_PATTERNS.includes(e.eventCode) && e.direction === "BEARISH" && e.algorithmVersion === config.priceActionAlgorithmVersion,
    );

    // Evaluate LONG side
    const bullishPattern = patterns.find((p) => BULLISH_PATTERNS.includes(p.code) && p.direction === "BULLISH");
    if (bullishPattern) {
      // Inverted Hammer Strategy Rule: Mandatory preceding downtrend check
      const isDowntrend = (supertrendTrend === "DOWN" || (supertrend !== null && candle.close < supertrend))
        || (emaFast !== null && candle.close < emaFast);

      let canTriggerLong = true;
      if (bullishPattern.code === "INVERTED_HAMMER" && !isDowntrend) {
        canTriggerLong = false;
      }

      if (canTriggerLong) {
        let longScore = 0;
        const evidence: TradeIdeaEvidence[] = [];

        // 1. Trend confirmation (+2)
        const trendBullish = (supertrendTrend === "UP" || (supertrend !== null && candle.close > supertrend))
          || (emaFast !== null && candle.close > emaFast);
        if (trendBullish) {
          longScore += 2;
          evidence.push({
            sourceType: "INDICATOR",
            sourceReference: "SUPERTREND/EMA",
            label: "Uptrend alignment",
            contribution: 0.25,
            details: { supertrend, supertrendTrend, emaFast },
          });
        }

        // 2. VWAP confluence (+2)
        if (vwap !== null && candle.close >= vwap - 0.5 * atr) {
          longScore += 2;
          evidence.push({
            sourceType: "INDICATOR",
            sourceReference: "VWAP",
            label: "Price above or bouncing at VWAP",
            contribution: 0.25,
            details: { vwap, close: candle.close },
          });
        }

        // 3. Support proximity (+2)
        if (nearestSupportDistanceAtr <= config.maxSrDistanceAtr) {
          longScore += 2;
          evidence.push({
            sourceType: "PRICE_ACTION",
            sourceReference: "SUPPORT",
            label: "Near support level",
            contribution: 0.25,
            details: { nearestSupportDistanceAtr },
          });
        }

        // 4. Volume Surge (+1)
        if (candle.volume > 0) {
          longScore += 1;
          evidence.push({
            sourceType: "INDICATOR",
            sourceReference: "VOLUME",
            label: "Volume participation",
            contribution: 0.12,
            details: { volume: candle.volume },
          });
        }

        // 5. Higher-Timeframe Confluence (+1 trend, +1 S/R, -1 disagreement)
        const htfTrendScore = calculateHtfTrendAlignment("BULLISH", context.higherTimeframes);
        const htfSrScore = calculateHtfSrConfluence(candle.close, "BULLISH", atr, context.higherTimeframes, config.maxSrDistanceAtr);
        const htfTotalScore = htfTrendScore + htfSrScore;
        if (htfTotalScore !== 0) {
          longScore += htfTotalScore;
          evidence.push({
            sourceType: "PRICE_ACTION",
            sourceReference: "HTF_CONFLUENCE",
            label: `Higher-timeframe confluence (${htfTotalScore > 0 ? "+" : ""}${htfTotalScore})`,
            contribution: rounded(htfTotalScore * 0.12),
            details: { htfTrendScore, htfSrScore, higherTimeframes: context.higherTimeframes },
          });
        }

        // 6. Macro Chart Pattern Confluence (+2)
        if (bullishChartPattern) {
          longScore += 2;
          evidence.push({
            sourceType: "PRICE_ACTION",
            sourceReference: bullishChartPattern.eventCode,
            label: `Chart pattern confluence: ${bullishChartPattern.eventCode}`,
            contribution: 0.25,
            details: { pattern: bullishChartPattern.eventCode, direction: bullishChartPattern.direction },
          });
        }

        // 7. Inverted Hammer Support Confluence Bonus (+1)
        if (bullishPattern.code === "INVERTED_HAMMER" && nearestSupportDistanceAtr <= 1.5) {
          longScore += 1;
          evidence.push({
            sourceType: "PATTERN",
            sourceReference: "INVERTED_HAMMER_SUPPORT",
            label: "Inverted Hammer at key support bonus",
            contribution: 0.12,
            details: { nearestSupportDistanceAtr },
          });
        }

        if (longScore >= config.scoreThreshold) {
          evidence.push({
            sourceType: "PATTERN",
            sourceReference: bullishPattern.code,
            label: `Trigger: ${bullishPattern.code}`,
            contribution: 0.35,
            details: { pattern: bullishPattern.code, confidence: bullishPattern.confidence },
          });

          const entryPrice = candle.close;
          const stopLoss = roundDownToTick(entryPrice - atr * config.atrStopMultiple, tickSize);
          const risk = entryPrice - stopLoss;
          const targetPrice = roundNearestToTick(entryPrice + risk * config.rewardRiskMultiple, tickSize);

          if (stopLoss < entryPrice && targetPrice > entryPrice && risk > 0) {
            const confidenceScore = clamp((longScore / 11) * 0.6 + bullishPattern.confidence * 0.4);
            const expiryMs = timeframeMilliseconds(candle.timeframe);
            const expiresAt = expiryMs ? new Date(candle.closeTime.getTime() + expiryMs * config.expiryCandles) : null;

            proposals.push({
              side: "LONG",
              entryPrice,
              stopLoss,
              targetPrice,
              riskReward: rounded((targetPrice - entryPrice) / risk),
              confidence: rounded(confidenceScore),
              reasoning: [
                `Context Score: ${longScore}/11 with ${bullishPattern.code} trigger.`,
                `Entry at ${entryPrice}, SL at ${stopLoss} (-${rounded(risk)}), Target at ${targetPrice} (+${rounded(targetPrice - entryPrice)}).`,
              ],
              evidence: {
                score: longScore,
                maxScore: 11,
                pattern: bullishPattern.code,
                strategyVersion: "momentum-scalp-pattern-v2",
                candlestickEngineVersion: config.candlestickAlgorithmVersion,
                chartPatternEngineVersion: config.priceActionAlgorithmVersion,
                featureSchemaVersion: null,
                configurationHash,
              },
              evidenceItems: evidence,
              expiresAt,
            });
          }
        }
      }
    }

    // Evaluate SHORT side (symmetrical)
    const bearishPattern = patterns.find((p) => BEARISH_PATTERNS.includes(p.code) && p.direction === "BEARISH");
    if (bearishPattern) {
      let shortScore = 0;
      const evidence: TradeIdeaEvidence[] = [];

      // 1. Trend confirmation (+2)
      const trendBearish = (supertrendTrend === "DOWN" || (supertrend !== null && candle.close < supertrend))
        || (emaFast !== null && candle.close < emaFast);
      if (trendBearish) {
        shortScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "SUPERTREND/EMA",
          label: "Downtrend alignment",
          contribution: 0.25,
          details: { supertrend, supertrendTrend, emaFast },
        });
      }

      // 2. VWAP confluence (+2)
      if (vwap !== null && candle.close <= vwap + 0.5 * atr) {
        shortScore += 2;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VWAP",
          label: "Price below or rejecting at VWAP",
          contribution: 0.25,
          details: { vwap, close: candle.close },
        });
      }

      // 3. Resistance proximity (+2)
      if (nearestResistanceDistanceAtr <= config.maxSrDistanceAtr) {
        shortScore += 2;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "RESISTANCE",
          label: "Near resistance level",
          contribution: 0.25,
          details: { nearestResistanceDistanceAtr },
        });
      }

      // 4. Volume Surge (+1)
      if (candle.volume > 0) {
        shortScore += 1;
        evidence.push({
          sourceType: "INDICATOR",
          sourceReference: "VOLUME",
          label: "Volume participation",
          contribution: 0.12,
          details: { volume: candle.volume },
        });
      }

      // 5. Higher-Timeframe Confluence (+1 trend, +1 S/R, -1 disagreement)
      const htfTrendScore = calculateHtfTrendAlignment("BEARISH", context.higherTimeframes);
      const htfSrScore = calculateHtfSrConfluence(candle.close, "BEARISH", atr, context.higherTimeframes, config.maxSrDistanceAtr);
      const htfTotalScore = htfTrendScore + htfSrScore;
      if (htfTotalScore !== 0) {
        shortScore += htfTotalScore;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: "HTF_CONFLUENCE",
          label: `Higher-timeframe confluence (${htfTotalScore > 0 ? "+" : ""}${htfTotalScore})`,
          contribution: rounded(htfTotalScore * 0.12),
          details: { htfTrendScore, htfSrScore, higherTimeframes: context.higherTimeframes },
        });
      }

      // 6. Macro Chart Pattern Confluence (+2)
      if (bearishChartPattern) {
        shortScore += 2;
        evidence.push({
          sourceType: "PRICE_ACTION",
          sourceReference: bearishChartPattern.eventCode,
          label: `Chart pattern confluence: ${bearishChartPattern.eventCode}`,
          contribution: 0.25,
          details: { pattern: bearishChartPattern.eventCode, direction: bearishChartPattern.direction },
        });
      }

      if (shortScore >= config.scoreThreshold) {
        evidence.push({
          sourceType: "PATTERN",
          sourceReference: bearishPattern.code,
          label: `Trigger: ${bearishPattern.code}`,
          contribution: 0.35,
          details: { pattern: bearishPattern.code, confidence: bearishPattern.confidence },
        });

        const entryPrice = candle.close;
        const stopLoss = roundUpToTick(entryPrice + atr * config.atrStopMultiple, tickSize);
        const risk = stopLoss - entryPrice;
        const targetPrice = roundNearestToTick(entryPrice - risk * config.rewardRiskMultiple, tickSize);

        if (stopLoss > entryPrice && targetPrice < entryPrice && risk > 0) {
          const confidenceScore = clamp((shortScore / 11) * 0.6 + bearishPattern.confidence * 0.4);
          const expiryMs = timeframeMilliseconds(candle.timeframe);
          const expiresAt = expiryMs ? new Date(candle.closeTime.getTime() + expiryMs * config.expiryCandles) : null;

          proposals.push({
            side: "SHORT",
            entryPrice,
            stopLoss,
            targetPrice,
            riskReward: rounded((entryPrice - targetPrice) / risk),
            confidence: rounded(confidenceScore),
            reasoning: [
              `Context Score: ${shortScore}/11 with ${bearishPattern.code} trigger.`,
              `Entry at ${entryPrice}, SL at ${stopLoss} (+${rounded(risk)}), Target at ${targetPrice} (-${rounded(entryPrice - targetPrice)}).`,
            ],
            evidence: {
              score: shortScore,
              maxScore: 11,
              pattern: bearishPattern.code,
              strategyVersion: "momentum-scalp-pattern-v2",
              candlestickEngineVersion: config.candlestickAlgorithmVersion,
              chartPatternEngineVersion: config.priceActionAlgorithmVersion,
              featureSchemaVersion: null,
              configurationHash,
            },
            evidenceItems: evidence,
            expiresAt,
          });
        }
      }
    }

    return proposals;
  }
}
