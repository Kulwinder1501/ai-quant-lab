import { createHash } from "node:crypto";
import {
  type ProposedTradeIdea,
  type StrategyMarketContext,
  type TradeIdeaEvidence,
  type TradeSide,
} from "./strategy.js";
import { type CandlestickPatternCode, type PatternDirection, type PriceActionEventCode } from "../../pattern-recognition/domain/market-pattern.js";
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
  /**
   * When true, trend confirmation (+2) requires Supertrend AND fast-EMA to agree, rather than
   * either alone.
   *
   * Default `false` reproduces the original behaviour exactly: `trendBullish` was `(supertrend
   * agrees) || (ema agrees)`, so a macro Supertrend reading DOWN still awarded the full +2 the
   * moment one 1-minute candle closed a tick above the fast EMA -- a micro-bounce inside a
   * downtrend, not an uptrend. Flagged 2026-09-30 against a real loss (BANKNIFTY LONG,
   * e670ca8d-aba0-434a-b058-f1a2e422f891) where this OR let a counter-trend bounce reach the
   * score gate. Off by default pending a replay against stored history -- an AND requirement is a
   * stricter, more plausible rule, but "more plausible" is not "measured", and this project's own
   * VWAP-ceiling and underlying-stop-confirmation checks both showed a plausible-sounding filter
   * making the outcome worse once replayed.
   *
   * Measured 2026-09-30 on BANKNIFTY 5m, 9 months (Jan-Sep 2026), quantity 30, ₹75/order + 2bps
   * slippage, single position: trade count drops 281 -> 210 (-25%) and the absolute loss shrinks
   * (-₹2,71,074 -> -₹2,12,340), but win rate and profit factor both get WORSE, not better (38.8% ->
   * 34.8%; 0.398 -> 0.374). The smaller loss is "traded less", the same shape as this project's
   * momentum-stall finding -- not evidence the surviving trades are any better. Both the baseline
   * and this arm sit well under the ~40% hit rate this strategy's own 1.5R geometry needs to break
   * even before fees; this flag does not touch that. Stays off pending a reason to expect it would
   * ever clear that bar.
   *
   * Optional, and deliberately absent from `defaultMomentumScalpPatternStrategyConfiguration`
   * rather than present and set to `false`: this strategy's version is frozen and already live
   * (`PostgresStrategyVersionRepository.ensure` refuses to re-register the same version under a
   * changed configuration), so the registered default must stay byte-identical to what v1 already
   * has on file. A caller opts in with an explicit override (`--strategy-config
   * '{"requireStrictTrendAlignment":true}'` in the backtest CLI, or the equivalent live
   * configuration override), never by editing the frozen default.
   */
  requireStrictTrendAlignment?: boolean;
  /**
   * When true, refuses a LONG proposal within `maxSrDistanceAtr` of the nearest overhead
   * resistance (and, symmetrically, a SHORT proposal within `maxSrDistanceAtr` of the nearest
   * underfoot support) -- reusing the same distance and the same price-action RESISTANCE/SUPPORT
   * events already computed for the opposite side's bonus, rather than a second, invented
   * threshold.
   *
   * Default `false`. The scoring below already awards SHORT +2 for being near resistance and LONG
   * +2 for being near support -- doctrinally sound, since a break of the opposing level favours a
   * reversal -- but nothing ever penalised the mirror case: a LONG proposal minted while price
   * sits directly under a resistance ceiling it has not yet broken. That gap is real and verified
   * against the source (`nearestResistanceDistanceAtr` is computed but read only on the SHORT
   * side). It was NOT, however, what caused the 2026-09-30 loss this flag is named alongside: that
   * trade's own price-action resistance distance was not what fired, and the trade's underlying
   * price never even reached its own invalidation level -- see the trade review. The veto is
   * correct on its own terms; it is off pending its own replay, not shipped as this trade's fix.
   *
   * Measured 2026-09-30, same BANKNIFTY 5m / 9-month setup as `requireStrictTrendAlignment`:
   * essentially a wash. Trades barely drop (281 -> 266, -5%), and win rate and profit factor both
   * move slightly the wrong way (38.8% -> 37.2%; 0.398 -> 0.373). Combined with strict trend
   * alignment the two together mostly just compound the volume reduction (197 trades, 35.0%,
   * 0.366) rather than showing any interaction effect. Neither arm nor the baseline clears this
   * strategy's own ~40% breakeven hit rate at its 1.5R geometry -- this veto does not address that.
   *
   * Optional and absent from the frozen default, for the same immutable-version reason as
   * `requireStrictTrendAlignment`.
   */
  enableSrVeto?: boolean;
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
  // requireStrictTrendAlignment / enableSrVeto deliberately omitted -- see their docstrings above.
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

/**
 * Picks the trigger pattern by the priority these arrays are written in -- Hammer and Engulfing
 * before Doji-family patterns -- rather than by whatever order `candidates` happened to arrive in.
 *
 * That distinction is not academic: `candidates` is `context.patterns`, which both the live and
 * backtest repositories return `ORDER BY pattern_definitions.pattern_code ASC` (alphabetical, a
 * storage detail with no doctrinal meaning). `candidates.find((p) => priorityOrder.includes(p.code))`
 * -- the code this replaces -- picks whichever candidate sorts first alphabetically among the ones
 * present, not the one `priorityOrder`'s own construction says should win. Measured against the
 * live `pattern_detections` table 2026-09-22: on candles where more than one bullish (or bearish)
 * pattern code fired together, alphabetical order picked the non-priority one 49% (bullish) / 45%
 * (bearish) of the time -- e.g. a candle carrying DRAGONFLY_DOJI, HAMMER and TWEEZER_BOTTOM
 * together had DRAGONFLY_DOJI (last in the list, weakest) win over HAMMER (first, strongest) purely
 * because 'D' < 'H'.
 *
 * This changes which pattern is credited in `evidence.pattern` / the `reasoning` text and, since
 * `bullishPattern.confidence` carries a real 40% weight in the reported confidence score, changes
 * that score too. It does not change whether a trade fires: the LONG/SHORT score gate below never
 * reads which specific candidate was selected, only whether one was present.
 */
function selectPriorityPattern<T extends { code: CandlestickPatternCode; direction: PatternDirection }>(
  candidates: readonly T[],
  priorityOrder: readonly CandlestickPatternCode[],
  direction: PatternDirection,
): T | undefined {
  for (const code of priorityOrder) {
    const match = candidates.find((candidate) => candidate.code === code && candidate.direction === direction);
    if (match) return match;
  }
  return undefined;
}

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
    requireStrictTrendAlignment: typeof raw.requireStrictTrendAlignment === "boolean" ? raw.requireStrictTrendAlignment : false,
    enableSrVeto: typeof raw.enableSrVeto === "boolean" ? raw.enableSrVeto : false,
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
    const bullishPattern = selectPriorityPattern(patterns, BULLISH_PATTERNS, "BULLISH");
    if (bullishPattern) {
      let longScore = 0;
      const evidence: TradeIdeaEvidence[] = [];

      // 1. Trend confirmation (+2)
      const supertrendBullish = supertrendTrend === "UP" || (supertrend !== null && candle.close > supertrend);
      const emaBullish = emaFast !== null && candle.close > emaFast;
      const trendBullish = config.requireStrictTrendAlignment
        ? (supertrendBullish && emaBullish)
        : (supertrendBullish || emaBullish);
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

      // Overhead resistance veto: refuses to buy directly under a ceiling it has not broken,
      // mirroring the resistance bonus already awarded to the SHORT side below. See
      // `enableSrVeto`'s docstring for why this is off by default.
      const resistanceVetoed = config.enableSrVeto && nearestResistanceDistanceAtr <= config.maxSrDistanceAtr;

      if (longScore >= config.scoreThreshold && !resistanceVetoed) {
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
    const bearishPattern = selectPriorityPattern(patterns, BEARISH_PATTERNS, "BEARISH");
    if (bearishPattern) {
      let shortScore = 0;
      const evidence: TradeIdeaEvidence[] = [];

      // 1. Trend confirmation (+2)
      const supertrendBearish = supertrendTrend === "DOWN" || (supertrend !== null && candle.close < supertrend);
      const emaBearish = emaFast !== null && candle.close < emaFast;
      const trendBearish = config.requireStrictTrendAlignment
        ? (supertrendBearish && emaBearish)
        : (supertrendBearish || emaBearish);
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

      // Underfoot support veto: the mirror of the resistance veto above -- refuses to short
      // directly over a floor it has not broken.
      const supportVetoed = config.enableSrVeto && nearestSupportDistanceAtr <= config.maxSrDistanceAtr;

      if (shortScore >= config.scoreThreshold && !supportVetoed) {
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
    const bullishPattern = selectPriorityPattern(patterns, BULLISH_PATTERNS, "BULLISH");
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
    const bearishPattern = selectPriorityPattern(patterns, BEARISH_PATTERNS, "BEARISH");
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
