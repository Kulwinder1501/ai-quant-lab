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

/**
 * The candlestick rule set that detection writes and consumers must read.
 *
 * `candlestick-v1` rows are a mixture of two rule sets: commit 2772538 gated INVERTED_HAMMER on a
 * downtrend without changing the version, and upserts never delete, so 19,928 of 20,153 stored
 * INVERTED_HAMMER rows pre-date the gate and 9,461 candles carry both INVERTED_HAMMER (bullish)
 * and SHOOTING_STAR (bearish). v2 additionally restates the rules (session-local series, intraday
 * prior-trend lookback, textbook open-gap for Piercing/Dark Cloud, tick floor for Doji, suppressed
 * zero-volume bars). v1 rows are marked superseded by migration 133 and must not be read.
 */
export const candlestickAlgorithmVersion = "candlestick-v2";
export const supersededCandlestickAlgorithmVersions = ["candlestick-v1"] as const;

/**
 * The price-action / chart-pattern rule set that detection writes and consumers must read.
 *
 * v4, current from 2026-10-30. It is the v3 rules with four corrections found on NIFTY 5m on 2026-10-29: the ATR is carried across
 * sessions (it restarted each morning, so nothing was emitted before about 10:25); a swing whose confirming candle is a suppressed
 * frozen-feed bar is re-anchored to the next real candle instead of being lost (the session high at 15:10 never appeared); a swing is
 * called SUPPORT or RESISTANCE only after a retest (`levelMinTouches: 2`) on the timeframes below 15m, the raw SWING_HIGH / SWING_LOW
 * being unchanged; and from 15m up the price-action rules run across sessions, because their 20-candle lookbacks do not fit in one
 * session there. Replayed against v3 on the pattern strategy AutoBot-Sniper ran (200 sessions, both indices) it changed 0.8% of its
 * trades and no measurable return (docs/2026-10-30-pattern-strategy-v3-vs-v4-price-action-results.md): the move is for the levels being
 * right, not for an edge.
 */
export const priceActionAlgorithmVersion = "price-action-v4";

/**
 * Labels that are no longer written. Their rows stay in the table as history, and every ordinary reader excludes them (see
 * `supersededPriceActionVersionsSql`), because several readers take support/resistance from every version in the loaded context and
 * two rule sets side by side would be read as one. `superseded-price-action-versions.test.ts` fails if a new reader of
 * `price_action_events` does not exclude them.
 *
 * v2 predates the session-local series and the timeframe-aware unit; v3 is the ATR-restarting-each-morning rule set v4 replaced;
 * `-atr` is the forced-ATR variant of each, a different unit being a different interpretation of the rules.
 */
export const supersededPriceActionAlgorithmVersions = ["price-action-v2", "price-action-v2-atr", "price-action-v3", "price-action-v3-atr"] as const;

/**
 * The superseded versions a strategy configuration explicitly pins through `priceActionAlgorithmVersion`, for the one reader allowed to
 * load them on request (the backtest loader, so a replay of a frozen cohort pinned to an old version still sees its rows). A
 * configuration that names the current version or nothing asks for none, so ordinary runs read only the current version.
 */
export function supersededPriceActionVersionsPinnedBy(configuration: Record<string, unknown> | null): string[] {
  const pinned = configuration?.priceActionAlgorithmVersion;
  return typeof pinned === "string" && (supersededPriceActionAlgorithmVersions as readonly string[]).includes(pinned) ? [pinned] : [];
}

/**
 * The quoted, comma-separated list for a `NOT IN (...)` clause. Built from the constants above, never from input; the check keeps a
 * future edit from putting a quote or a space into a label that is spliced into SQL text.
 */
export function supersededPriceActionVersionsSql(): string {
  return supersededPriceActionAlgorithmVersions
    .map((version) => {
      if (!/^[a-z0-9-]+$/.test(version)) throw new Error(`Unsafe price-action algorithm version label: ${version}`);
      return `'${version}'`;
    })
    .join(", ");
}

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
  /**
   * A bounded rule-strength score in [0, 1] -- an uncalibrated heuristic, NOT a probability of
   * the pattern working. The name is kept because it is the persisted column. For DOJI it is
   * `1 - bodyRatio` and, since a doji requires `bodyRatio <= 0.1`, it is always >= 0.9: it
   * restates the detection threshold and carries no information beyond "this is a doji".
   */
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

