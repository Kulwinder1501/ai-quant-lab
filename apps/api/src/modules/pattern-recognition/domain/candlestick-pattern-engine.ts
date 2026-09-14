import {
  type CandlestickPatternCode,
  type DetectedCandlestickPattern,
  type PatternCandle,
  type PatternDirection,
} from "./market-pattern.js";

export interface CandlestickPatternConfiguration {
  dojiBodyRatio: number;
  dragonflyUpperShadowRatio: number;
  gravestoneLowerShadowRatio: number;
  longShadowBodyMultiplier: number;
  shortShadowBodyMultiplier: number;
  smallBodyRatio: number;
  spinningTopMinBodyRatio: number;
  spinningTopMaxBodyRatio: number;
  spinningTopMinShadowRatio: number;
  spinningTopMaxShadowImbalance: number;
  trendLookback: number;
  tweezerAtrTolerance: number;
  marubozuMaxWickRatio: number;
  marubozuMinBodyRatio: number;
  piercingMinPenetration: number;
  darkCloudMinPenetration: number;
}

const defaultConfiguration: CandlestickPatternConfiguration = {
  dojiBodyRatio: 0.1,
  dragonflyUpperShadowRatio: 0.05,
  gravestoneLowerShadowRatio: 0.05,
  longShadowBodyMultiplier: 2,
  shortShadowBodyMultiplier: 0.6,
  smallBodyRatio: 0.35,
  spinningTopMinBodyRatio: 0.10,
  spinningTopMaxBodyRatio: 0.35,
  spinningTopMinShadowRatio: 0.20,
  spinningTopMaxShadowImbalance: 0.50,
  trendLookback: 3,
  tweezerAtrTolerance: 0.1,
  marubozuMaxWickRatio: 0.05,
  marubozuMinBodyRatio: 0.9,
  piercingMinPenetration: 0.5,
  darkCloudMinPenetration: 0.5,
};

interface CandleShape {
  range: number;
  body: number;
  upperShadow: number;
  lowerShadow: number;
  bodyRatio: number;
  bullish: boolean;
  bearish: boolean;
}

function shape(candle: PatternCandle): CandleShape {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperShadow = candle.high - Math.max(candle.open, candle.close);
  const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
  return {
    range,
    body,
    upperShadow,
    lowerShadow,
    bodyRatio: range === 0 ? 0 : body / range,
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open,
  };
}

function confidence(...components: number[]): number {
  return Math.max(0, Math.min(1, components.reduce((sum, component) => sum + component, 0) / components.length));
}

function isUptrend(candles: readonly PatternCandle[], index: number, lookback: number): boolean {
  return index > lookback && candles[index - 1].close > candles[index - lookback - 1].close;
}

function isDowntrend(candles: readonly PatternCandle[], index: number, lookback: number): boolean {
  return index > lookback && candles[index - 1].close < candles[index - lookback - 1].close;
}

function calculateTrailingAtr(candles: readonly PatternCandle[], index: number, period = 14): number {
  const start = Math.max(0, index - period + 1);
  let trSum = 0;
  let count = 0;
  for (let i = start; i <= index; i += 1) {
    const current = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const tr = prev
      ? Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close))
      : current.high - current.low;
    trSum += tr;
    count += 1;
  }
  return count > 0 ? trSum / count : 0;
}

function detection(
  candle: PatternCandle,
  patternCode: CandlestickPatternCode,
  direction: PatternDirection,
  confidenceScore: number,
  context: PatternCandle[],
  details: Record<string, unknown>,
): DetectedCandlestickPattern {
  return {
    candleId: candle.id,
    patternCode,
    direction,
    confidence: Math.max(0, Math.min(1, confidenceScore)),
    contextCandleIds: context.map((contextCandle) => contextCandle.id),
    details,
  };
}

/** Deterministic textbook-inspired pattern rules with explicit thresholds and trend context. */
export class CandlestickPatternEngine {
  constructor(private readonly configuration: CandlestickPatternConfiguration = defaultConfiguration) {}

  detect(candles: readonly PatternCandle[]): DetectedCandlestickPattern[] {
    const results: DetectedCandlestickPattern[] = [];
    for (let index = 0; index < candles.length; index += 1) {
      const current = candles[index];
      const currentShape = shape(current);
      if (currentShape.range <= 0) continue;
      const downtrend = isDowntrend(candles, index, this.configuration.trendLookback);
      const uptrend = isUptrend(candles, index, this.configuration.trendLookback);

      // --- 1-CANDLE PATTERNS ---

      // 1. DOJI
      if (currentShape.bodyRatio <= this.configuration.dojiBodyRatio) {
        results.push(detection(current, "DOJI", "NEUTRAL", 1 - currentShape.bodyRatio, [current], {
          bodyRatio: currentShape.bodyRatio,
          range: currentShape.range,
        }));

        // 2. DRAGONFLY DOJI: long lower shadow, virtually no upper shadow
        if (
          currentShape.upperShadow <= currentShape.range * this.configuration.dragonflyUpperShadowRatio
          && currentShape.lowerShadow >= currentShape.range * 0.6
        ) {
          const direction: PatternDirection = downtrend ? "BULLISH" : "NEUTRAL";
          results.push(detection(current, "DRAGONFLY_DOJI", direction, confidence(
            1 - currentShape.bodyRatio,
            currentShape.lowerShadow / currentShape.range,
            downtrend ? 0.9 : 0.6,
          ), [current], { lowerShadow: currentShape.lowerShadow, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }

        // 3. GRAVESTONE DOJI: long upper shadow, virtually no lower shadow
        if (
          currentShape.lowerShadow <= currentShape.range * this.configuration.gravestoneLowerShadowRatio
          && currentShape.upperShadow >= currentShape.range * 0.6
        ) {
          const direction: PatternDirection = uptrend ? "BEARISH" : "NEUTRAL";
          results.push(detection(current, "GRAVESTONE_DOJI", direction, confidence(
            1 - currentShape.bodyRatio,
            currentShape.upperShadow / currentShape.range,
            uptrend ? 0.9 : 0.6,
          ), [current], { upperShadow: currentShape.upperShadow, trend: uptrend ? "UP" : "UNKNOWN" }));
        }
      }

      // 4. HAMMER & HANGING MAN
      const minimumBody = Math.max(currentShape.body, currentShape.range * this.configuration.dojiBodyRatio);
      const lowerShadowShape = currentShape.lowerShadow >= minimumBody * this.configuration.longShadowBodyMultiplier
        && currentShape.upperShadow <= minimumBody * this.configuration.shortShadowBodyMultiplier;
      if (lowerShadowShape && downtrend) {
        results.push(detection(current, "HAMMER", "BULLISH", confidence(
          Math.min(1, currentShape.lowerShadow / (minimumBody * this.configuration.longShadowBodyMultiplier)),
          1 - currentShape.upperShadow / Math.max(currentShape.range, 1e-9),
          0.85,
        ), [current], { lowerShadow: currentShape.lowerShadow, upperShadow: currentShape.upperShadow, trend: "DOWN" }));
      }
      if (lowerShadowShape && uptrend) {
        results.push(detection(current, "HANGING_MAN", "BEARISH", confidence(
          Math.min(1, currentShape.lowerShadow / (minimumBody * this.configuration.longShadowBodyMultiplier)),
          1 - currentShape.upperShadow / Math.max(currentShape.range, 1e-9),
          0.85,
        ), [current], { lowerShadow: currentShape.lowerShadow, upperShadow: currentShape.upperShadow, trend: "UP" }));
      }

      // 5. SHOOTING STAR & INVERTED HAMMER
      const upperShadowShape = currentShape.upperShadow >= minimumBody * this.configuration.longShadowBodyMultiplier
        && currentShape.lowerShadow <= minimumBody * this.configuration.shortShadowBodyMultiplier;
      if (upperShadowShape && uptrend) {
        results.push(detection(current, "SHOOTING_STAR", "BEARISH", confidence(
          Math.min(1, currentShape.upperShadow / (minimumBody * this.configuration.longShadowBodyMultiplier)),
          1 - currentShape.lowerShadow / Math.max(currentShape.range, 1e-9),
          0.85,
        ), [current], { upperShadow: currentShape.upperShadow, lowerShadow: currentShape.lowerShadow, trend: "UP" }));
      }
      // Pure geometry for Inverted Hammer: small body, long upper shadow, short lower shadow
      if (upperShadowShape && currentShape.bodyRatio <= this.configuration.smallBodyRatio) {
        results.push(detection(current, "INVERTED_HAMMER", "BULLISH", confidence(
          Math.min(1, currentShape.upperShadow / (minimumBody * this.configuration.longShadowBodyMultiplier)),
          1 - currentShape.lowerShadow / Math.max(currentShape.range, 1e-9),
          0.85,
        ), [current], { upperShadow: currentShape.upperShadow, lowerShadow: currentShape.lowerShadow, bodyRatio: currentShape.bodyRatio }));
      }

      // 5b. SPINNING TOP (Neutral indecision candle with small body and balanced shadows)
      const isSpinningTop = currentShape.bodyRatio > this.configuration.spinningTopMinBodyRatio
        && currentShape.bodyRatio <= this.configuration.spinningTopMaxBodyRatio
        && currentShape.upperShadow >= currentShape.range * this.configuration.spinningTopMinShadowRatio
        && currentShape.lowerShadow >= currentShape.range * this.configuration.spinningTopMinShadowRatio
        && Math.abs(currentShape.upperShadow - currentShape.lowerShadow) <= currentShape.range * this.configuration.spinningTopMaxShadowImbalance;
      if (isSpinningTop) {
        results.push(detection(current, "SPINNING_TOP", "NEUTRAL", confidence(
          1 - currentShape.bodyRatio,
          0.75,
        ), [current], { bodyRatio: currentShape.bodyRatio, upperShadow: currentShape.upperShadow, lowerShadow: currentShape.lowerShadow }));
      }

      // 6. BULLISH & BEARISH MARUBOZU
      if (
        currentShape.bodyRatio >= this.configuration.marubozuMinBodyRatio
        && currentShape.upperShadow <= currentShape.range * this.configuration.marubozuMaxWickRatio
        && currentShape.lowerShadow <= currentShape.range * this.configuration.marubozuMaxWickRatio
      ) {
        if (currentShape.bullish) {
          results.push(detection(current, "BULLISH_MARUBOZU", "BULLISH", confidence(
            currentShape.bodyRatio,
            0.9,
          ), [current], { bodyRatio: currentShape.bodyRatio, range: currentShape.range }));
        } else if (currentShape.bearish) {
          results.push(detection(current, "BEARISH_MARUBOZU", "BEARISH", confidence(
            currentShape.bodyRatio,
            0.9,
          ), [current], { bodyRatio: currentShape.bodyRatio, range: currentShape.range }));
        }
      }

      // --- 2-CANDLE PATTERNS ---
      if (index >= 1) {
        const previous = candles[index - 1];
        const previousShape = shape(previous);

        // 7. ENGULFING PATTERNS
        if (
          previousShape.bearish
          && currentShape.bullish
          && current.open <= previous.close
          && current.close >= previous.open
          && currentShape.body > previousShape.body
        ) {
          results.push(detection(current, "BULLISH_ENGULFING", "BULLISH", confidence(
            Math.min(1, currentShape.body / Math.max(previousShape.body, 1e-9)), downtrend ? 1 : 0.6,
          ), [previous, current], { previousBody: previousShape.body, currentBody: currentShape.body, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }
        if (
          previousShape.bullish
          && currentShape.bearish
          && current.open >= previous.close
          && current.close <= previous.open
          && currentShape.body > previousShape.body
        ) {
          results.push(detection(current, "BEARISH_ENGULFING", "BEARISH", confidence(
            Math.min(1, currentShape.body / Math.max(previousShape.body, 1e-9)), uptrend ? 1 : 0.6,
          ), [previous, current], { previousBody: previousShape.body, currentBody: currentShape.body, trend: uptrend ? "UP" : "UNKNOWN" }));
        }

        // 8. HARAMI PATTERNS
        const bodyLow = Math.min(previous.open, previous.close);
        const bodyHigh = Math.max(previous.open, previous.close);
        const currentBodyLow = Math.min(current.open, current.close);
        const currentBodyHigh = Math.max(current.open, current.close);
        if (
          previousShape.bearish
          && currentShape.bullish
          && currentBodyLow >= bodyLow
          && currentBodyHigh <= bodyHigh
          && currentShape.body < previousShape.body
        ) {
          results.push(detection(current, "BULLISH_HARAMI", "BULLISH", confidence(
            1 - currentShape.body / Math.max(previousShape.body, 1e-9), downtrend ? 1 : 0.6,
          ), [previous, current], { previousBodyLow: bodyLow, previousBodyHigh: bodyHigh, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }
        if (
          previousShape.bullish
          && currentShape.bearish
          && currentBodyLow >= bodyLow
          && currentBodyHigh <= bodyHigh
          && currentShape.body < previousShape.body
        ) {
          results.push(detection(current, "BEARISH_HARAMI", "BEARISH", confidence(
            1 - currentShape.body / Math.max(previousShape.body, 1e-9), uptrend ? 1 : 0.6,
          ), [previous, current], { previousBodyLow: bodyLow, previousBodyHigh: bodyHigh, trend: uptrend ? "UP" : "UNKNOWN" }));
        }

        // 9. INSIDE & OUTSIDE BARS
        if (current.high < previous.high && current.low > previous.low) {
          results.push(detection(current, "INSIDE_BAR", "NEUTRAL", confidence(
            1 - currentShape.range / previousShape.range,
            0.8,
          ), [previous, current], { motherBarHigh: previous.high, motherBarLow: previous.low }));
        }
        if (current.high > previous.high && current.low < previous.low) {
          const direction: PatternDirection = current.close > previous.close ? "BULLISH" : current.close < previous.close ? "BEARISH" : "NEUTRAL";
          results.push(detection(current, "OUTSIDE_BAR", direction, confidence(
            Math.min(1, currentShape.range / previousShape.range),
            direction === "NEUTRAL" ? 0.5 : 0.8,
          ), [previous, current], { previousHigh: previous.high, previousLow: previous.low }));
        }

        // 10. PIERCING LINE: Prior bearish, current opens below prior low (or close) and closes above midpoint of prior body
        const priorMidpoint = (previous.open + previous.close) / 2;
        if (
          previousShape.bearish
          && currentShape.bullish
          && (current.open <= previous.low || current.open < previous.close)
          && current.close > priorMidpoint
          && current.close < previous.open
        ) {
          const penetration = (current.close - previous.close) / Math.max(previousShape.body, 1e-9);
          if (penetration >= this.configuration.piercingMinPenetration) {
            results.push(detection(current, "PIERCING_LINE", "BULLISH", confidence(
              Math.min(1, penetration),
              downtrend ? 1 : 0.65,
              0.85,
            ), [previous, current], { priorMidpoint, penetration, trend: downtrend ? "DOWN" : "UNKNOWN" }));
          }
        }

        // 11. DARK CLOUD COVER: Prior bullish, current opens above prior high (or close) and closes below midpoint of prior body
        if (
          previousShape.bullish
          && currentShape.bearish
          && (current.open >= previous.high || current.open > previous.close)
          && current.close < priorMidpoint
          && current.close > previous.open
        ) {
          const penetration = (previous.close - current.close) / Math.max(previousShape.body, 1e-9);
          if (penetration >= this.configuration.darkCloudMinPenetration) {
            results.push(detection(current, "DARK_CLOUD_COVER", "BEARISH", confidence(
              Math.min(1, penetration),
              uptrend ? 1 : 0.65,
              0.85,
            ), [previous, current], { priorMidpoint, penetration, trend: uptrend ? "UP" : "UNKNOWN" }));
          }
        }

        // 12. TWEEZER BOTTOM: Matching lows within volatility tolerance
        const atr = calculateTrailingAtr(candles, index);
        const tweezerTolerance = atr > 0
          ? this.configuration.tweezerAtrTolerance * atr
          : this.configuration.tweezerAtrTolerance * currentShape.range;

        if (
          Math.abs(previous.low - current.low) <= tweezerTolerance
          && previousShape.bearish
          && (currentShape.bullish || currentShape.lowerShadow >= currentShape.range * 0.4)
        ) {
          const lowDiff = Math.abs(previous.low - current.low);
          results.push(detection(current, "TWEEZER_BOTTOM", "BULLISH", confidence(
            1 - (lowDiff / Math.max(tweezerTolerance, 1e-9)),
            downtrend ? 1 : 0.65,
            0.85,
          ), [previous, current], { lowDifference: lowDiff, tolerance: tweezerTolerance, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }

        // 13. TWEEZER TOP: Matching highs within volatility tolerance
        if (
          Math.abs(previous.high - current.high) <= tweezerTolerance
          && previousShape.bullish
          && (currentShape.bearish || currentShape.upperShadow >= currentShape.range * 0.4)
        ) {
          const highDiff = Math.abs(previous.high - current.high);
          results.push(detection(current, "TWEEZER_TOP", "BEARISH", confidence(
            1 - (highDiff / Math.max(tweezerTolerance, 1e-9)),
            uptrend ? 1 : 0.65,
            0.85,
          ), [previous, current], { highDifference: highDiff, tolerance: tweezerTolerance, trend: uptrend ? "UP" : "UNKNOWN" }));
        }
      }

      // --- 3-CANDLE PATTERNS ---
      if (index >= 2) {
        const first = candles[index - 2];
        const second = candles[index - 1];
        const firstShape = shape(first);
        const secondShape = shape(second);
        const midpoint = (first.open + first.close) / 2;

        // 14. MORNING STAR
        if (
          firstShape.bearish
          && secondShape.bodyRatio <= this.configuration.smallBodyRatio
          && currentShape.bullish
          && current.close > midpoint
          && downtrend
        ) {
          results.push(detection(current, "MORNING_STAR", "BULLISH", confidence(
            1 - secondShape.bodyRatio,
            Math.min(1, (current.close - midpoint) / Math.max(firstShape.body / 2, 1e-9)),
            0.9,
          ), [first, second, current], { midpoint, secondBodyRatio: secondShape.bodyRatio }));
        }

        // 15. EVENING STAR
        if (
          firstShape.bullish
          && secondShape.bodyRatio <= this.configuration.smallBodyRatio
          && currentShape.bearish
          && current.close < midpoint
          && uptrend
        ) {
          results.push(detection(current, "EVENING_STAR", "BEARISH", confidence(
            1 - secondShape.bodyRatio,
            Math.min(1, (midpoint - current.close) / Math.max(firstShape.body / 2, 1e-9)),
            0.9,
          ), [first, second, current], { midpoint, secondBodyRatio: secondShape.bodyRatio }));
        }

        // 16. THREE WHITE SOLDIERS
        const shapes = [firstShape, secondShape, currentShape];
        const closes = [first.close, second.close, current.close];
        const opens = [first.open, second.open, current.open];
        if (
          shapes.every((candidate) => candidate.bullish)
          && closes[0] < closes[1] && closes[1] < closes[2]
          && opens[1] >= first.open && opens[1] <= first.close
          && opens[2] >= second.open && opens[2] <= second.close
          && downtrend
        ) {
          results.push(detection(current, "THREE_WHITE_SOLDIERS", "BULLISH", confidence(
            Math.min(1, currentShape.bodyRatio / 0.5), 0.9,
          ), [first, second, current], { closes, trend: "DOWN" }));
        }

        // 17. THREE BLACK CROWS
        if (
          shapes.every((candidate) => candidate.bearish)
          && closes[0] > closes[1] && closes[1] > closes[2]
          && opens[1] <= first.open && opens[1] >= first.close
          && opens[2] <= second.open && opens[2] >= second.close
          && uptrend
        ) {
          results.push(detection(current, "THREE_BLACK_CROWS", "BEARISH", confidence(
            Math.min(1, currentShape.bodyRatio / 0.5), 0.9,
          ), [first, second, current], { closes, trend: "UP" }));
        }

        // 18. THREE INSIDE UP: Bearish candle 1, Bullish Harami candle 2, Bullish candle 3 closing above candle 1 open (TA-Lib canonical)
        const firstBodyLow = Math.min(first.open, first.close);
        const firstBodyHigh = Math.max(first.open, first.close);
        const secondBodyLow = Math.min(second.open, second.close);
        const secondBodyHigh = Math.max(second.open, second.close);

        if (
          firstShape.bearish
          && firstShape.bodyRatio >= this.configuration.smallBodyRatio
          && secondShape.bullish
          && secondBodyLow >= firstBodyLow
          && secondBodyHigh <= firstBodyHigh
          && secondShape.body < firstShape.body
          && currentShape.bullish
          && current.close > first.open
        ) {
          results.push(detection(current, "THREE_INSIDE_UP", "BULLISH", confidence(
            Math.min(1, (current.close - first.open) / Math.max(firstShape.body, 1e-9) + 0.5),
            downtrend ? 1 : 0.7,
            0.9,
          ), [first, second, current], { firstOpen: first.open, confirmationClose: current.close, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }

        // 19. THREE INSIDE DOWN: Bullish candle 1, Bearish Harami candle 2, Bearish candle 3 closing below candle 1 open (TA-Lib canonical)
        if (
          firstShape.bullish
          && firstShape.bodyRatio >= this.configuration.smallBodyRatio
          && secondShape.bearish
          && secondBodyLow >= firstBodyLow
          && secondBodyHigh <= firstBodyHigh
          && secondShape.body < firstShape.body
          && currentShape.bearish
          && current.close < first.open
        ) {
          results.push(detection(current, "THREE_INSIDE_DOWN", "BEARISH", confidence(
            Math.min(1, (first.open - current.close) / Math.max(firstShape.body, 1e-9) + 0.5),
            uptrend ? 1 : 0.7,
            0.9,
          ), [first, second, current], { firstOpen: first.open, confirmationClose: current.close, trend: uptrend ? "UP" : "UNKNOWN" }));
        }
      }
    }
    return results;
  }
}
