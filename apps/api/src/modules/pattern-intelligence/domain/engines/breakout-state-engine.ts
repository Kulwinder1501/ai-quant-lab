import type {
  BreakoutStateDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface BreakoutStateCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: BreakoutStateDetails["subtype"];
  orientation: PatternOrientation;
  breakoutLevel: number;
  breakoutDistanceBps: number;
  patternHigh: number;
  patternLow: number;
}

export interface BreakoutStateEngineConfig {
  lookbackBars: number;
  minBreakoutBps: number;
  retestToleranceBps: number;
}

export const defaultBreakoutStateConfig: BreakoutStateEngineConfig = {
  lookbackBars: 20,
  minBreakoutBps: 3.0,
  retestToleranceBps: 4.0,
};

export class BreakoutStateEngine {
  constructor(private readonly config: BreakoutStateEngineConfig = defaultBreakoutStateConfig) {}

  detect(candles: readonly CandleLike[]): BreakoutStateCandidate[] {
    if (candles.length < 5) return [];
    const candidates: BreakoutStateCandidate[] = [];

    for (let i = 4; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = candles[i - 1]!;
      const lookbackStart = Math.max(0, i - this.config.lookbackBars);

      // Find local resistance and support over lookback (prior to prev)
      let resLevel = -Infinity;
      let supLevel = Infinity;
      let resIdx = -1;
      let supIdx = -1;

      for (let j = lookbackStart; j < i - 1; j++) {
        if (candles[j]!.high > resLevel) {
          resLevel = candles[j]!.high;
          resIdx = j;
        }
        if (candles[j]!.low < supLevel) {
          supLevel = candles[j]!.low;
          supIdx = j;
        }
      }

      // 1. Upside Breakout
      if (resIdx >= 0 && resLevel > 0) {
        // Current bar closes above resistance level
        if (current.close > resLevel && prev.close <= resLevel) {
          const breakoutDistanceBps = ((current.close - resLevel) / resLevel) * 10000;
          if (breakoutDistanceBps >= this.config.minBreakoutBps) {
            candidates.push({
              startIndex: resIdx,
              detectedIndex: i,
              subtype: "BREAKOUT",
              orientation: "UP",
              breakoutLevel: resLevel,
              breakoutDistanceBps: Number(breakoutDistanceBps.toFixed(6)),
              patternHigh: current.high,
              patternLow: Math.min(...candles.slice(resIdx, i + 1).map((c) => c.low)),
            });
          }
        }

        // Failed Breakout (broke out on prev bar or intra-bar, but current bar closes back below)
        if (prev.high > resLevel && current.close < resLevel && current.open > resLevel * 0.999) {
          const breakoutDistanceBps = ((prev.high - resLevel) / resLevel) * 10000;
          candidates.push({
            startIndex: resIdx,
            detectedIndex: i,
            subtype: "FAILED_BREAKOUT",
            orientation: "DOWN",
            breakoutLevel: resLevel,
            breakoutDistanceBps: Number(breakoutDistanceBps.toFixed(6)),
            patternHigh: Math.max(prev.high, current.high),
            patternLow: current.low,
          });
        }

        // Retest after breakout: price broke out 1-3 bars ago, now pulls back to touch resistance (now support) and bounces
        if (i >= 3 && candles[i - 2]!.close > resLevel && current.low <= resLevel * (1 + this.config.retestToleranceBps / 10000) && current.close > resLevel) {
          const distanceBps = ((current.close - resLevel) / resLevel) * 10000;
          candidates.push({
            startIndex: resIdx,
            detectedIndex: i,
            subtype: "RETEST_AFTER_BREAKOUT",
            orientation: "UP",
            breakoutLevel: resLevel,
            breakoutDistanceBps: Number(distanceBps.toFixed(6)),
            patternHigh: Math.max(...candles.slice(i - 2, i + 1).map((c) => c.high)),
            patternLow: current.low,
          });
        }
      }

      // 2. Downside Breakdown
      if (supIdx >= 0 && supLevel < Infinity) {
        if (current.close < supLevel && prev.close >= supLevel) {
          const breakdownDistanceBps = ((supLevel - current.close) / supLevel) * 10000;
          if (breakdownDistanceBps >= this.config.minBreakoutBps) {
            candidates.push({
              startIndex: supIdx,
              detectedIndex: i,
              subtype: "BREAKDOWN",
              orientation: "DOWN",
              breakoutLevel: supLevel,
              breakoutDistanceBps: Number(breakdownDistanceBps.toFixed(6)),
              patternHigh: Math.max(...candles.slice(supIdx, i + 1).map((c) => c.high)),
              patternLow: current.low,
            });
          }
        }

        // Failed Breakdown
        if (prev.low < supLevel && current.close > supLevel) {
          const distanceBps = ((supLevel - prev.low) / supLevel) * 10000;
          candidates.push({
            startIndex: supIdx,
            detectedIndex: i,
            subtype: "FAILED_BREAKDOWN",
            orientation: "UP",
            breakoutLevel: supLevel,
            breakoutDistanceBps: Number(distanceBps.toFixed(6)),
            patternHigh: current.high,
            patternLow: Math.min(prev.low, current.low),
          });
        }

        // Retest after breakdown
        if (i >= 3 && candles[i - 2]!.close < supLevel && current.high >= supLevel * (1 - this.config.retestToleranceBps / 10000) && current.close < supLevel) {
          const distanceBps = ((supLevel - current.close) / supLevel) * 10000;
          candidates.push({
            startIndex: supIdx,
            detectedIndex: i,
            subtype: "RETEST_AFTER_BREAKDOWN",
            orientation: "DOWN",
            breakoutLevel: supLevel,
            breakoutDistanceBps: Number(distanceBps.toFixed(6)),
            patternHigh: current.high,
            patternLow: Math.min(...candles.slice(i - 2, i + 1).map((c) => c.low)),
          });
        }
      }
    }

    return candidates;
  }
}
