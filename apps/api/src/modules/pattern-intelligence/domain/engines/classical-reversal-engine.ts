import type {
  ClassicalReversalDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface ClassicalReversalCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: ClassicalReversalDetails["subtype"];
  orientation: PatternOrientation;
  necklineLevel: number | null;
  patternHigh: number;
  patternLow: number;
}

export class ClassicalReversalEngine {
  detect(candles: readonly CandleLike[]): ClassicalReversalCandidate[] {
    if (candles.length < 5) return [];
    const candidates: ClassicalReversalCandidate[] = [];

    // Find local peaks and valleys
    for (let i = 4; i < candles.length; i++) {
      const current = candles[i]!;

      // Double Top / Bottom
      if (i >= 6) {
        const c0 = candles[i - 6]!;
        const c1 = candles[i - 4]!;
        const c2 = candles[i - 2]!;
        const c3 = current;

        // Double Top: Two matching peaks with valley in between, closing below valley
        const peaksMatch = Math.abs(c0.high - c2.high) / c0.high < 0.003;
        const valley = c1.low;
        if (peaksMatch && c0.high > valley && c2.high > valley && c3.close < valley) {
          candidates.push({
            startIndex: i - 6,
            detectedIndex: i,
            subtype: "DOUBLE_TOP",
            orientation: "DOWN",
            necklineLevel: valley,
            patternHigh: Math.max(c0.high, c2.high),
            patternLow: valley,
          });
        }

        // Double Bottom: Two matching valleys with peak in between, closing above peak
        const valleysMatch = Math.abs(c0.low - c2.low) / c0.low < 0.003;
        const peak = c1.high;
        if (valleysMatch && c0.low < peak && c2.low < peak && c3.close > peak) {
          candidates.push({
            startIndex: i - 6,
            detectedIndex: i,
            subtype: "DOUBLE_BOTTOM",
            orientation: "UP",
            necklineLevel: peak,
            patternHigh: peak,
            patternLow: Math.min(c0.low, c2.low),
          });
        }
      }

      // Head and Shoulders (Left Shoulder, Head, Right Shoulder)
      if (i >= 8) {
        const ls = candles[i - 8]!;
        const head = candles[i - 5]!;
        const rs = candles[i - 2]!;
        const valley1 = candles[i - 6]!.low;
        const valley2 = candles[i - 3]!.low;
        const neckline = (valley1 + valley2) / 2;

        /*
         * `head.high` must clear both valleys, not just both shoulders. Nothing upstream guarantees
         * that on fixed-offset candle sampling (as opposed to genuine swing-point detection): a
         * small-bodied head candle can still beat both shoulder highs while sitting below a valley
         * candle's low, producing patternHigh < patternLow downstream (measured 2026-09-16, NIFTY50
         * 1m 2026-09-11: head 23351.6 vs valley 23352.85). A real head-and-shoulders top is the
         * highest point of the whole formation by definition, so this is a correctness condition on
         * the pattern, not an extra filter.
         */
        if (head.high > ls.high && head.high > rs.high && head.high > valley1 && head.high > valley2
          && Math.abs(ls.high - rs.high) / head.high < 0.01) {
          if (current.close < neckline) {
            candidates.push({
              startIndex: i - 8,
              detectedIndex: i,
              subtype: "HEAD_AND_SHOULDERS",
              orientation: "DOWN",
              necklineLevel: neckline,
              patternHigh: head.high,
              patternLow: Math.min(valley1, valley2),
            });
          }
        }

        // Inverse Head and Shoulders
        const peak1 = candles[i - 6]!.high;
        const peak2 = candles[i - 3]!.high;
        const invNeckline = (peak1 + peak2) / 2;
        // Symmetric correctness condition: the head must undercut both peaks, not just both
        // shoulders, so patternHigh (the higher peak) stays above patternLow (the head).
        if (head.low < ls.low && head.low < rs.low && head.low < peak1 && head.low < peak2
          && Math.abs(ls.low - rs.low) / head.low < 0.01) {
          if (current.close > invNeckline) {
            candidates.push({
              startIndex: i - 8,
              detectedIndex: i,
              subtype: "INVERSE_HEAD_AND_SHOULDERS",
              orientation: "UP",
              necklineLevel: invNeckline,
              patternHigh: Math.max(peak1, peak2),
              patternLow: head.low,
            });
          }
        }
      }
    }

    return candidates;
  }
}
