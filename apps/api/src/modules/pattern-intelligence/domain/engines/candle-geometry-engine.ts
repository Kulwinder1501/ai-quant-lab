import type {
  CandleGeometryDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface CandleGeometryCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: CandleGeometryDetails["subtype"];
  orientation: PatternOrientation;
  patternHigh: number;
  patternLow: number;
}

export class CandleGeometryEngine {
  detect(candles: readonly CandleLike[]): CandleGeometryCandidate[] {
    if (candles.length === 0) return [];
    const candidates: CandleGeometryCandidate[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      const range = c.high - c.low;
      if (range <= 0) continue;

      const body = Math.abs(c.close - c.open);
      const upperShadow = c.high - Math.max(c.open, c.close);
      const lowerShadow = Math.min(c.open, c.close) - c.low;
      const bodyRatio = body / range;

      // 1. Doji family
      if (bodyRatio <= 0.10) {
        if (upperShadow <= range * 0.05 && lowerShadow >= range * 0.70) {
          candidates.push({ startIndex: i, detectedIndex: i, subtype: "DRAGONFLY_DOJI", orientation: "UP", patternHigh: c.high, patternLow: c.low });
        } else if (lowerShadow <= range * 0.05 && upperShadow >= range * 0.70) {
          candidates.push({ startIndex: i, detectedIndex: i, subtype: "GRAVESTONE_DOJI", orientation: "DOWN", patternHigh: c.high, patternLow: c.low });
        } else {
          candidates.push({ startIndex: i, detectedIndex: i, subtype: "DOJI", orientation: "NONE", patternHigh: c.high, patternLow: c.low });
        }
      }

      // 2. Hammer & Hanging Man (lower shadow >= 2.0x body, small upper shadow <= 0.1x range)
      if (lowerShadow >= 2.0 * body && upperShadow <= 0.15 * range && bodyRatio > 0.10 && bodyRatio <= 0.40) {
        // Hammer
        candidates.push({ startIndex: i, detectedIndex: i, subtype: "HAMMER", orientation: "UP", patternHigh: c.high, patternLow: c.low });
        // Hanging Man
        candidates.push({ startIndex: i, detectedIndex: i, subtype: "HANGING_MAN", orientation: "DOWN", patternHigh: c.high, patternLow: c.low });
      }

      // 3. Shooting Star & Inverted Hammer (upper shadow >= 2.0x body, small lower shadow)
      if (upperShadow >= 2.0 * body && lowerShadow <= 0.15 * range && bodyRatio > 0.10 && bodyRatio <= 0.40) {
        candidates.push({ startIndex: i, detectedIndex: i, subtype: "SHOOTING_STAR", orientation: "DOWN", patternHigh: c.high, patternLow: c.low });
        candidates.push({ startIndex: i, detectedIndex: i, subtype: "INVERTED_HAMMER", orientation: "UP", patternHigh: c.high, patternLow: c.low });
      }

      // 4. Marubozu (Body >= 85% of total range)
      if (bodyRatio >= 0.85) {
        if (c.close > c.open) {
          candidates.push({ startIndex: i, detectedIndex: i, subtype: "BULLISH_MARUBOZU", orientation: "UP", patternHigh: c.high, patternLow: c.low });
        } else {
          candidates.push({ startIndex: i, detectedIndex: i, subtype: "BEARISH_MARUBOZU", orientation: "DOWN", patternHigh: c.high, patternLow: c.low });
        }
      }

      // 5. Spinning Top (small body 15-35%, roughly balanced shadows)
      if (bodyRatio >= 0.15 && bodyRatio <= 0.35 && upperShadow >= range * 0.25 && lowerShadow >= range * 0.25) {
        candidates.push({ startIndex: i, detectedIndex: i, subtype: "SPINNING_TOP", orientation: "NONE", patternHigh: c.high, patternLow: c.low });
      }

      // 6. Two-candle patterns (Engulfing, Inside, Outside, Tweezers, Kickers)
      if (i >= 1) {
        const prev = candles[i - 1]!;
        const prevRange = prev.high - prev.low;

        // Bullish Engulfing: Current green body engulfs prior red body
        if (prev.close < prev.open && c.close > c.open && c.open <= prev.close && c.close >= prev.open) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "BULLISH_ENGULFING", orientation: "UP", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }

        // Bearish Engulfing: Current red body engulfs prior green body
        if (prev.close > prev.open && c.close < c.open && c.open >= prev.close && c.close <= prev.open) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "BEARISH_ENGULFING", orientation: "DOWN", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }

        // Inside Bar & Outside Bar
        if (c.high <= prev.high && c.low >= prev.low) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "INSIDE_BAR", orientation: "BIDIRECTIONAL", patternHigh: prev.high, patternLow: prev.low });
        }
        if (c.high >= prev.high && c.low <= prev.low && range > prevRange) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "OUTSIDE_BAR", orientation: c.close > c.open ? "UP" : "DOWN", patternHigh: c.high, patternLow: c.low });
        }

        // Tweezers (matching highs or matching lows within tight tolerance)
        const tol = (c.high + prev.high) * 0.0002;
        if (Math.abs(c.high - prev.high) <= tol && upperShadow >= range * 0.3) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "TWEEZER_TOP", orientation: "DOWN", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }
        if (Math.abs(c.low - prev.low) <= tol && lowerShadow >= range * 0.3) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "TWEEZER_BOTTOM", orientation: "UP", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }

        // Kicker: Marubozu-like candles separated by a gap
        if (prev.close < prev.open && c.close > c.open && c.open > prev.open && bodyRatio >= 0.7 && (prev.open - prev.close) / prevRange >= 0.7) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "KICKER_UP", orientation: "UP", patternHigh: c.high, patternLow: prev.low });
        }
        if (prev.close > prev.open && c.close < c.open && c.open < prev.open && bodyRatio >= 0.7 && (prev.close - prev.open) / prevRange >= 0.7) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "KICKER_DOWN", orientation: "DOWN", patternHigh: prev.high, patternLow: c.low });
        }
      }

      // 7. Three-line strike
      if (i >= 3) {
        const c0 = candles[i - 3]!;
        const c1 = candles[i - 2]!;
        const c2 = candles[i - 1]!;
        const c3 = c;

        // Bullish Three-Line Strike: 3 consecutive rising candles followed by a deep strike down engulfing all 3
        if (c0.close > c0.open && c1.close > c1.open && c2.close > c2.open && c3.close < c3.open && c3.open >= c2.close && c3.close <= c0.open) {
          candidates.push({ startIndex: i - 3, detectedIndex: i, subtype: "THREE_LINE_STRIKE_UP", orientation: "UP", patternHigh: Math.max(c0.high, c1.high, c2.high, c3.high), patternLow: Math.min(c0.low, c1.low, c2.low, c3.low) });
        }

        // Bearish Three-Line Strike: 3 consecutive falling candles followed by a strike up engulfing all 3
        if (c0.close < c0.open && c1.close < c1.open && c2.close < c2.open && c3.close > c3.open && c3.open <= c2.close && c3.close >= c0.open) {
          candidates.push({ startIndex: i - 3, detectedIndex: i, subtype: "THREE_LINE_STRIKE_DOWN", orientation: "DOWN", patternHigh: Math.max(c0.high, c1.high, c2.high, c3.high), patternLow: Math.min(c0.low, c1.low, c2.low, c3.low) });
        }
      }
    }

    return candidates;
  }
}
