import type {
  ContinuationStructureDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface ContinuationStructureCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: ContinuationStructureDetails["subtype"];
  orientation: PatternOrientation;
  patternHigh: number;
  patternLow: number;
}

export class ContinuationStructureEngine {
  detect(candles: readonly CandleLike[]): ContinuationStructureCandidate[] {
    if (candles.length < 6) return [];
    const candidates: ContinuationStructureCandidate[] = [];

    for (let i = 5; i < candles.length; i++) {
      const current = candles[i]!;

      // Bull Flag: Strong impulsive pole up (3 bars) -> Tight downward sloping consolidation (2-3 bars) -> Breakout up
      const poleStart = candles[i - 5]!;
      const polePeak = candles[i - 3]!;
      const flagLow = Math.min(candles[i - 2]!.low, candles[i - 1]!.low);
      const flagHigh = Math.max(candles[i - 2]!.high, candles[i - 1]!.high);

      const poleGain = polePeak.high - poleStart.low;
      const retrace = polePeak.high - flagLow;

      if (poleGain > 0 && retrace <= poleGain * 0.50 && flagHigh <= polePeak.high) {
        if (current.close > flagHigh) {
          candidates.push({
            startIndex: i - 5,
            detectedIndex: i,
            subtype: "BULL_FLAG",
            orientation: "UP",
            patternHigh: current.high,
            patternLow: poleStart.low,
          });
        }
      }

      // Bear Flag: Strong impulsive pole down -> Tight upward consolidation -> Breakdown
      const bearPoleStart = candles[i - 5]!;
      const bearPoleTrough = candles[i - 3]!;
      const bearFlagHigh = Math.max(candles[i - 2]!.high, candles[i - 1]!.high);
      const bearFlagLow = Math.min(candles[i - 2]!.low, candles[i - 1]!.low);

      const bearPoleLoss = bearPoleStart.high - bearPoleTrough.low;
      const bearRetrace = bearFlagHigh - bearPoleTrough.low;

      if (bearPoleLoss > 0 && bearRetrace <= bearPoleLoss * 0.50 && bearFlagLow >= bearPoleTrough.low) {
        if (current.close < bearFlagLow) {
          candidates.push({
            startIndex: i - 5,
            detectedIndex: i,
            subtype: "BEAR_FLAG",
            orientation: "DOWN",
            patternHigh: bearPoleStart.high,
            patternLow: current.low,
          });
        }
      }

      // Pullback continuation in trend
      if (i >= 4) {
        const c0 = candles[i - 3]!;
        const c1 = candles[i - 2]!;
        const c2 = candles[i - 1]!;

        // Uptrend pullback: 2 red candles followed by bullish engulfing / reclaim
        if (c0.close > c0.open && c1.close < c1.open && c2.close < c2.open && current.close > c1.high) {
          candidates.push({
            startIndex: i - 3,
            detectedIndex: i,
            subtype: "PULLBACK_CONTINUATION",
            orientation: "UP",
            patternHigh: current.high,
            patternLow: Math.min(c1.low, c2.low),
          });
        }
        // Downtrend pullback
        if (c0.close < c0.open && c1.close > c1.open && c2.close > c2.open && current.close < c1.low) {
          candidates.push({
            startIndex: i - 3,
            detectedIndex: i,
            subtype: "PULLBACK_CONTINUATION",
            orientation: "DOWN",
            patternHigh: Math.max(c1.high, c2.high),
            patternLow: current.low,
          });
        }
      }
    }

    return candidates;
  }
}
