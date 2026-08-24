export const candlestickPatternCodes = [
  "DOJI",
  "DRAGONFLY_DOJI",
  "GRAVESTONE_DOJI",
  "HAMMER",
  "INVERTED_HAMMER",
  "HANGING_MAN",
  "SHOOTING_STAR",
  "SPINNING_TOP",
  "BULLISH_ENGULFING",
  "BEARISH_ENGULFING",
  "MORNING_STAR",
  "EVENING_STAR",
  "BULLISH_HARAMI",
  "BEARISH_HARAMI",
  "THREE_WHITE_SOLDIERS",
  "THREE_BLACK_CROWS",
  "INSIDE_BAR",
  "OUTSIDE_BAR",
  "PIERCING_LINE",
  "DARK_CLOUD_COVER",
  "TWEEZER_BOTTOM",
  "TWEEZER_TOP",
  "BULLISH_MARUBOZU",
  "BEARISH_MARUBOZU",
  "THREE_INSIDE_UP",
  "THREE_INSIDE_DOWN",
] as const;

export type CandlestickPatternCode = (typeof candlestickPatternCodes)[number];
export type PatternDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export const priceActionEventCodes = [
  "BREAKOUT",
  "BREAKDOWN",
  "SUPPORT",
  "RESISTANCE",
  "UPTREND",
  "DOWNTREND",
  "RANGE",
  "PULLBACK",
  "SWING_HIGH",
  "SWING_LOW",
  "DOUBLE_BOTTOM",
  "DOUBLE_TOP",
  "BULL_FLAG",
  "BEAR_FLAG",
  "ASCENDING_TRIANGLE",
  "DESCENDING_TRIANGLE",
  "HEAD_AND_SHOULDERS",
  "INVERSE_HEAD_AND_SHOULDERS",
  "RISING_WEDGE",
  "FALLING_WEDGE",
] as const;

export type PriceActionEventCode = (typeof priceActionEventCodes)[number];

export interface PatternCandle {
  id: string;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DetectedCandlestickPattern {
  candleId: string;
  patternCode: CandlestickPatternCode;
  direction: PatternDirection;
  confidence: number;
  contextCandleIds: string[];
  details: Record<string, unknown>;
}

export interface DetectedPriceActionEvent {
  candleId: string;
  eventCode: PriceActionEventCode;
  direction: PatternDirection;
  level: number | null;
  confidence: number;
  details: Record<string, unknown>;
}

export interface PatternDefinition {
  id: string;
  code: CandlestickPatternCode;
  algorithmVersion: string;
}

export interface PatternDefinitionRepository {
  ensure(input: { code: CandlestickPatternCode; algorithmVersion: string; description: string }): Promise<PatternDefinition>;
}

export interface PatternDetectionRepository {
  upsert(input: {
    candleId: string;
    patternDefinitionId: string;
    direction: PatternDirection;
    confidence: number;
    contextCandleIds: string[];
    details: Record<string, unknown>;
  }): Promise<void>;
}

export interface PriceActionEventRepository {
  upsert(input: {
    candleId: string;
    eventCode: PriceActionEventCode;
    direction: PatternDirection;
    level: number | null;
    confidence: number;
    algorithmVersion: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * The feature layers a consumer can ask to have been computed before it reads a candle.
 *
 * These name the two engines whose output is stored as rows-if-found, which is why coverage has to
 * be recorded separately: zero detections and zero runs are the same absence in
 * `pattern_detections` / `price_action_events`.
 */
export const candlestickPatternLayer = "CANDLESTICK_PATTERN";
export const priceActionLayer = "PRICE_ACTION";

/**
 * Marks a candle as *processed* by a feature layer, whatever the layer found.
 *
 * Written for every candle in a detection pass's write window, including the ones that produced
 * nothing. Without it a reader cannot tell a quiet bar from an unprocessed one, and the scalp
 * research harness spent 2026-08-24 freezing unprocessed bars as though they were quiet.
 */
export interface CandleFeatureCoverageRepository {
  record(input: {
    candleIds: readonly string[];
    featureLayer: string;
    algorithmVersion: string;
  }): Promise<void>;
}

export const candlestickPatternDescriptions: Record<CandlestickPatternCode, string> = {
  DOJI: "Small real body relative to the full candle range.",
  DRAGONFLY_DOJI: "Doji with a long lower shadow and virtually no upper shadow.",
  GRAVESTONE_DOJI: "Doji with a long upper shadow and virtually no lower shadow.",
  HAMMER: "Lower-shadow reversal shape confirmed after a decline.",
  INVERTED_HAMMER: "Upper-shadow reversal shape confirmed after a decline at support.",
  HANGING_MAN: "Lower-shadow warning shape confirmed after an advance.",
  SHOOTING_STAR: "Upper-shadow reversal shape confirmed after an advance.",
  SPINNING_TOP: "Small real body with roughly balanced upper and lower shadows.",
  BULLISH_ENGULFING: "Bullish real body engulfs the preceding bearish body.",
  BEARISH_ENGULFING: "Bearish real body engulfs the preceding bullish body.",
  MORNING_STAR: "Three-candle bullish reversal sequence after a decline.",
  EVENING_STAR: "Three-candle bearish reversal sequence after an advance.",
  BULLISH_HARAMI: "Small bullish body sits inside a preceding bearish body.",
  BEARISH_HARAMI: "Small bearish body sits inside a preceding bullish body.",
  THREE_WHITE_SOLDIERS: "Three consecutive advancing bullish candles.",
  THREE_BLACK_CROWS: "Three consecutive declining bearish candles.",
  INSIDE_BAR: "Current range is contained in the preceding range.",
  OUTSIDE_BAR: "Current range contains the preceding range.",
  PIERCING_LINE: "Bullish reversal opening below prior low and closing above midpoint of prior bearish body.",
  DARK_CLOUD_COVER: "Bearish reversal opening above prior high and closing below midpoint of prior bullish body.",
  TWEEZER_BOTTOM: "Two consecutive candles with matching lows within volatility tolerance.",
  TWEEZER_TOP: "Two consecutive candles with matching highs within volatility tolerance.",
  BULLISH_MARUBOZU: "Strong bullish candle with long body and minimal shadows.",
  BEARISH_MARUBOZU: "Strong bearish candle with long body and minimal shadows.",
  THREE_INSIDE_UP: "Bullish Harami followed by a third bullish candle closing above the first candle open.",
  THREE_INSIDE_DOWN: "Bearish Harami followed by a third bearish candle closing below the first candle open.",
};

