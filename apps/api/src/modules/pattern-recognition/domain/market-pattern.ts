export const candlestickPatternCodes = [
  "DOJI",
  "HAMMER",
  "HANGING_MAN",
  "SHOOTING_STAR",
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
] as const;

export type CandlestickPatternCode = (typeof candlestickPatternCodes)[number];
export type PatternDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type PriceActionEventCode = "BREAKOUT" | "BREAKDOWN" | "SUPPORT" | "RESISTANCE" | "UPTREND" | "DOWNTREND" | "RANGE" | "PULLBACK" | "SWING_HIGH" | "SWING_LOW";

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

export const candlestickPatternDescriptions: Record<CandlestickPatternCode, string> = {
  DOJI: "Small real body relative to the full candle range.",
  HAMMER: "Lower-shadow reversal shape confirmed after a decline.",
  HANGING_MAN: "Lower-shadow warning shape confirmed after an advance.",
  SHOOTING_STAR: "Upper-shadow reversal shape confirmed after an advance.",
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
};
