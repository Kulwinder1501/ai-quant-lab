import type {
  LevelInteractionDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface KeyLevel {
  type: LevelInteractionDetails["levelType"];
  value: number;
}

export interface LevelInteractionCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: LevelInteractionDetails["subtype"];
  orientation: PatternOrientation;
  levelType: LevelInteractionDetails["levelType"];
  levelValue: number;
  distanceBps: number;
  patternHigh: number;
  patternLow: number;
}

export class LevelInteractionEngine {
  detect(candles: readonly CandleLike[], levels: readonly KeyLevel[]): LevelInteractionCandidate[] {
    if (candles.length < 2 || levels.length === 0) return [];
    const candidates: LevelInteractionCandidate[] = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = candles[i - 1]!;

      for (const level of levels) {
        if (level.value <= 0) continue;
        const distBps = ((current.close - level.value) / level.value) * 10000;

        // 1. Break and Hold: Crosses level and stays above (or below)
        if (prev.close <= level.value && current.close > level.value && current.low >= level.value * 0.999) {
          candidates.push({
            startIndex: i - 1,
            detectedIndex: i,
            subtype: "BREAK_AND_HOLD",
            orientation: "UP",
            levelType: level.type,
            levelValue: level.value,
            distanceBps: Number(distBps.toFixed(6)),
            patternHigh: current.high,
            patternLow: prev.low,
          });
        } else if (prev.close >= level.value && current.close < level.value && current.high <= level.value * 1.001) {
          candidates.push({
            startIndex: i - 1,
            detectedIndex: i,
            subtype: "BREAK_AND_HOLD",
            orientation: "DOWN",
            levelType: level.type,
            levelValue: level.value,
            distanceBps: Number(distBps.toFixed(6)),
            patternHigh: prev.high,
            patternLow: current.low,
          });
        }

        // 2. Sweep and Reject: Penetrates level intra-bar, but closes on the opposite side
        if (current.high > level.value && current.close < level.value && prev.close < level.value) {
          candidates.push({
            startIndex: i - 1,
            detectedIndex: i,
            subtype: "SWEEP_AND_REJECT",
            orientation: "DOWN",
            levelType: level.type,
            levelValue: level.value,
            distanceBps: Number(distBps.toFixed(6)),
            patternHigh: current.high,
            patternLow: current.low,
          });
        } else if (current.low < level.value && current.close > level.value && prev.close > level.value) {
          candidates.push({
            startIndex: i - 1,
            detectedIndex: i,
            subtype: "SWEEP_AND_REJECT",
            orientation: "UP",
            levelType: level.type,
            levelValue: level.value,
            distanceBps: Number(distBps.toFixed(6)),
            patternHigh: current.high,
            patternLow: current.low,
          });
        }
      }
    }

    return candidates;
  }
}
