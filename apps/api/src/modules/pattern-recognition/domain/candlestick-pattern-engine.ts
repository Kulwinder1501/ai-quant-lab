import {
  type CandlestickPatternCode,
  type DetectedCandlestickPattern,
  type PatternCandle,
  type PatternDirection,
} from "./market-pattern.js";

export interface CandlestickPatternConfiguration {
  dojiBodyRatio: number;
  longShadowBodyMultiplier: number;
  shortShadowBodyMultiplier: number;
  smallBodyRatio: number;
  trendLookback: number;
}

const defaultConfiguration: CandlestickPatternConfiguration = {
  dojiBodyRatio: 0.1,
  longShadowBodyMultiplier: 2,
  shortShadowBodyMultiplier: 0.6,
  smallBodyRatio: 0.35,
  trendLookback: 3,
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

      if (currentShape.bodyRatio <= this.configuration.dojiBodyRatio) {
        results.push(detection(current, "DOJI", "NEUTRAL", 1 - currentShape.bodyRatio, [current], {
          bodyRatio: currentShape.bodyRatio,
          range: currentShape.range,
        }));
      }

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

      const upperShadowShape = currentShape.upperShadow >= minimumBody * this.configuration.longShadowBodyMultiplier
        && currentShape.lowerShadow <= minimumBody * this.configuration.shortShadowBodyMultiplier;
      if (upperShadowShape && uptrend) {
        results.push(detection(current, "SHOOTING_STAR", "BEARISH", confidence(
          Math.min(1, currentShape.upperShadow / (minimumBody * this.configuration.longShadowBodyMultiplier)),
          1 - currentShape.lowerShadow / Math.max(currentShape.range, 1e-9),
          0.85,
        ), [current], { upperShadow: currentShape.upperShadow, lowerShadow: currentShape.lowerShadow, trend: "UP" }));
      }

      if (index >= 1) {
        const previous = candles[index - 1];
        const previousShape = shape(previous);
        if (previousShape.bearish && currentShape.bullish && current.open <= previous.close && current.close >= previous.open && currentShape.body > previousShape.body) {
          results.push(detection(current, "BULLISH_ENGULFING", "BULLISH", confidence(
            Math.min(1, currentShape.body / Math.max(previousShape.body, 1e-9)), downtrend ? 1 : 0.6,
          ), [previous, current], { previousBody: previousShape.body, currentBody: currentShape.body, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }
        if (previousShape.bullish && currentShape.bearish && current.open >= previous.close && current.close <= previous.open && currentShape.body > previousShape.body) {
          results.push(detection(current, "BEARISH_ENGULFING", "BEARISH", confidence(
            Math.min(1, currentShape.body / Math.max(previousShape.body, 1e-9)), uptrend ? 1 : 0.6,
          ), [previous, current], { previousBody: previousShape.body, currentBody: currentShape.body, trend: uptrend ? "UP" : "UNKNOWN" }));
        }
        const bodyLow = Math.min(previous.open, previous.close);
        const bodyHigh = Math.max(previous.open, previous.close);
        const currentBodyLow = Math.min(current.open, current.close);
        const currentBodyHigh = Math.max(current.open, current.close);
        if (previousShape.bearish && currentShape.bullish && currentBodyLow >= bodyLow && currentBodyHigh <= bodyHigh && currentShape.body < previousShape.body) {
          results.push(detection(current, "BULLISH_HARAMI", "BULLISH", confidence(
            1 - currentShape.body / Math.max(previousShape.body, 1e-9), downtrend ? 1 : 0.6,
          ), [previous, current], { previousBodyLow: bodyLow, previousBodyHigh: bodyHigh, trend: downtrend ? "DOWN" : "UNKNOWN" }));
        }
        if (previousShape.bullish && currentShape.bearish && currentBodyLow >= bodyLow && currentBodyHigh <= bodyHigh && currentShape.body < previousShape.body) {
          results.push(detection(current, "BEARISH_HARAMI", "BEARISH", confidence(
            1 - currentShape.body / Math.max(previousShape.body, 1e-9), uptrend ? 1 : 0.6,
          ), [previous, current], { previousBodyLow: bodyLow, previousBodyHigh: bodyHigh, trend: uptrend ? "UP" : "UNKNOWN" }));
        }
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
      }

      if (index >= 2) {
        const first = candles[index - 2];
        const second = candles[index - 1];
        const firstShape = shape(first);
        const secondShape = shape(second);
        const midpoint = (first.open + first.close) / 2;
        if (firstShape.bearish && secondShape.bodyRatio <= this.configuration.smallBodyRatio && currentShape.bullish && current.close > midpoint && downtrend) {
          results.push(detection(current, "MORNING_STAR", "BULLISH", confidence(
            1 - secondShape.bodyRatio,
            Math.min(1, (current.close - midpoint) / Math.max(firstShape.body / 2, 1e-9)),
            0.9,
          ), [first, second, current], { midpoint, secondBodyRatio: secondShape.bodyRatio }));
        }
        if (firstShape.bullish && secondShape.bodyRatio <= this.configuration.smallBodyRatio && currentShape.bearish && current.close < midpoint && uptrend) {
          results.push(detection(current, "EVENING_STAR", "BEARISH", confidence(
            1 - secondShape.bodyRatio,
            Math.min(1, (midpoint - current.close) / Math.max(firstShape.body / 2, 1e-9)),
            0.9,
          ), [first, second, current], { midpoint, secondBodyRatio: secondShape.bodyRatio }));
        }
        const shapes = [firstShape, secondShape, currentShape];
        const closes = [first.close, second.close, current.close];
        const opens = [first.open, second.open, current.open];
        if (shapes.every((candidate) => candidate.bullish) && closes[0] < closes[1] && closes[1] < closes[2] && opens[1] >= first.open && opens[1] <= first.close && opens[2] >= second.open && opens[2] <= second.close && downtrend) {
          results.push(detection(current, "THREE_WHITE_SOLDIERS", "BULLISH", confidence(
            Math.min(1, currentShape.bodyRatio / 0.5), 0.9,
          ), [first, second, current], { closes, trend: "DOWN" }));
        }
        if (shapes.every((candidate) => candidate.bearish) && closes[0] > closes[1] && closes[1] > closes[2] && opens[1] <= first.open && opens[1] >= first.close && opens[2] <= second.open && opens[2] >= second.close && uptrend) {
          results.push(detection(current, "THREE_BLACK_CROWS", "BEARISH", confidence(
            Math.min(1, currentShape.bodyRatio / 0.5), 0.9,
          ), [first, second, current], { closes, trend: "UP" }));
        }
      }
    }
    return results;
  }
}
