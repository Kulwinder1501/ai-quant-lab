import type {
  MultiCandleDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface MultiCandleCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: MultiCandleDetails["subtype"];
  orientation: PatternOrientation;
  patternHigh: number;
  patternLow: number;
}

export class MultiCandleEngine {
  detect(candles: readonly CandleLike[]): MultiCandleCandidate[] {
    if (candles.length < 2) return [];
    const candidates: MultiCandleCandidate[] = [];

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      const prevBody = Math.abs(prev.close - prev.open);
      const currBody = Math.abs(c.close - c.open);

      // 1. Harami family (2-bar)
      if (prevBody > 0 && currBody / prevBody <= 0.6) {
        const isContained = Math.max(c.open, c.close) <= Math.max(prev.open, prev.close) &&
                            Math.min(c.open, c.close) >= Math.min(prev.open, prev.close);
        if (isContained) {
          if (currBody / (c.high - c.low || 1) <= 0.1) {
            candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "HARAMI_CROSS", orientation: prev.close < prev.open ? "UP" : "DOWN", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
          } else if (prev.close < prev.open && c.close > c.open) {
            candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "BULLISH_HARAMI", orientation: "UP", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
          } else if (prev.close > prev.open && c.close < c.open) {
            candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "BEARISH_HARAMI", orientation: "DOWN", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
          }
        }
      }

      // 2. Piercing Line & Dark Cloud Cover (2-bar)
      if (prev.close < prev.open && c.close > c.open && c.open < prev.low) {
        const midpoint = (prev.open + prev.close) / 2;
        if (c.close > midpoint && c.close < prev.open) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "PIERCING_LINE", orientation: "UP", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }
      }
      if (prev.close > prev.open && c.close < c.open && c.open > prev.high) {
        const midpoint = (prev.open + prev.close) / 2;
        if (c.close < midpoint && c.close > prev.open) {
          candidates.push({ startIndex: i - 1, detectedIndex: i, subtype: "DARK_CLOUD_COVER", orientation: "DOWN", patternHigh: Math.max(prev.high, c.high), patternLow: Math.min(prev.low, c.low) });
        }
      }

      // 3. Three-candle patterns
      if (i >= 2) {
        const c0 = candles[i - 2]!;
        const c1 = candles[i - 1]!;
        const c2 = c;

        // Morning Star (Bearish candle -> Small gap-down candle -> Bullish candle into first body)
        if (c0.close < c0.open && (c0.open - c0.close) > (c0.high - c0.low) * 0.5) {
          const c1Body = Math.abs(c1.close - c1.open);
          if (c1Body <= (c0.open - c0.close) * 0.4 && c1.close < c0.close) {
            if (c2.close > c2.open && c2.close > (c0.open + c0.close) / 2) {
              candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "MORNING_STAR", orientation: "UP", patternHigh: Math.max(c0.high, c1.high, c2.high), patternLow: Math.min(c0.low, c1.low, c2.low) });
            }
          }
        }

        // Evening Star (Bullish candle -> Small gap-up candle -> Bearish candle into first body)
        if (c0.close > c0.open && (c0.close - c0.open) > (c0.high - c0.low) * 0.5) {
          const c1Body = Math.abs(c1.close - c1.open);
          if (c1Body <= (c0.close - c0.open) * 0.4 && c1.close > c0.close) {
            if (c2.close < c2.open && c2.close < (c0.open + c0.close) / 2) {
              candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "EVENING_STAR", orientation: "DOWN", patternHigh: Math.max(c0.high, c1.high, c2.high), patternLow: Math.min(c0.low, c1.low, c2.low) });
            }
          }
        }

        // Three White Soldiers (3 consecutive advancing bullish candles)
        if (c0.close > c0.open && c1.close > c1.open && c2.close > c2.open) {
          if (c1.open > c0.open && c1.open < c0.close && c2.open > c1.open && c2.open < c1.close && c2.close > c1.close && c1.close > c0.close) {
            candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "THREE_WHITE_SOLDIERS", orientation: "UP", patternHigh: c2.high, patternLow: c0.low });
          }
        }

        // Three Black Crows (3 consecutive declining bearish candles)
        if (c0.close < c0.open && c1.close < c1.open && c2.close < c2.open) {
          if (c1.open < c0.open && c1.open > c0.close && c2.open < c1.open && c2.open > c1.close && c2.close < c1.close && c1.close < c0.close) {
            candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "THREE_BLACK_CROWS", orientation: "DOWN", patternHigh: c0.high, patternLow: c2.low });
          }
        }

        // Three Inside Up / Down (Harami confirmed by 3rd bar)
        if (c0.close < c0.open && c1.close > c1.open && c1.open >= c0.close && c1.close <= c0.open && c2.close > c0.open) {
          candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "THREE_INSIDE_UP", orientation: "UP", patternHigh: Math.max(c0.high, c1.high, c2.high), patternLow: Math.min(c0.low, c1.low, c2.low) });
        }
        if (c0.close > c0.open && c1.close < c1.open && c1.open <= c0.close && c1.close >= c0.open && c2.close < c0.open) {
          candidates.push({ startIndex: i - 2, detectedIndex: i, subtype: "THREE_INSIDE_DOWN", orientation: "DOWN", patternHigh: Math.max(c0.high, c1.high, c2.high), patternLow: Math.min(c0.low, c1.low, c2.low) });
        }
      }

      // 4. Five-candle patterns (Rising / Falling Three Methods)
      if (i >= 4) {
        const c0 = candles[i - 4]!;
        const c1 = candles[i - 3]!;
        const c2 = candles[i - 2]!;
        const c3 = candles[i - 1]!;
        const c4 = c;

        // Rising Three Methods: Strong long green candle -> 3 small counter-trend red candles inside its range -> Strong green closing above c0 high
        if (c0.close > c0.open && c4.close > c4.open && c4.close > c0.high) {
          const inside0 = [c1, c2, c3].every((bar) => bar.high <= c0.high && bar.low >= c0.low);
          const mostlyBearish = (c1.close <= c1.open ? 1 : 0) + (c2.close <= c2.open ? 1 : 0) + (c3.close <= c3.open ? 1 : 0) >= 2;
          if (inside0 && mostlyBearish) {
            candidates.push({ startIndex: i - 4, detectedIndex: i, subtype: "RISING_THREE_METHODS", orientation: "UP", patternHigh: c4.high, patternLow: c0.low });
          }
        }

        // Falling Three Methods: Strong long red candle -> 3 small green candles inside range -> Strong red closing below c0 low
        if (c0.close < c0.open && c4.close < c4.open && c4.close < c0.low) {
          const inside0 = [c1, c2, c3].every((bar) => bar.high <= c0.high && bar.low >= c0.low);
          const mostlyBullish = (c1.close >= c1.open ? 1 : 0) + (c2.close >= c2.open ? 1 : 0) + (c3.close >= c3.open ? 1 : 0) >= 2;
          if (inside0 && mostlyBullish) {
            candidates.push({ startIndex: i - 4, detectedIndex: i, subtype: "FALLING_THREE_METHODS", orientation: "DOWN", patternHigh: c0.high, patternLow: c4.low });
          }
        }
      }
    }

    return candidates;
  }
}
