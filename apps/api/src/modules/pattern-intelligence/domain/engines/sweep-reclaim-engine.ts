import type {
  ObservationSource,
  PatternDefinitionRef,
  PatternOrientation,
  SweepReclaimDetails,
} from "../contracts.js";
import {
  calculateAtrSeries,
  calculateEmaSeries,
  calculatePatternContext,
  calculatePatternGeometry,
  type CandleLike,
} from "../pattern-context-calculator.js";

export interface SweepCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: SweepReclaimDetails["subtype"];
  wyckoffEquivalent: "SPRING" | "UPTHRUST" | null;
  orientation: PatternOrientation;
  referenceLevel: number;
  penetrationExcursionBps: number;
  reclaimDistanceBps: number;
  rejectionWickBps: number;
  patternHigh: number;
  patternLow: number;
}

export interface SweepReclaimEngineConfig {
  lookbackBars: number;
  minPenetrationBps: number;
  maxExcursionAtr: number;
  minReclaimBps: number;
}

export const defaultSweepReclaimConfig: SweepReclaimEngineConfig = {
  lookbackBars: 20,
  minPenetrationBps: 2.0,
  maxExcursionAtr: 2.5,
  minReclaimBps: 3.0,
};

export class SweepReclaimEngine {
  constructor(private readonly config: SweepReclaimEngineConfig = defaultSweepReclaimConfig) {}

  detect(candles: readonly CandleLike[], referenceLevels?: { pdh?: number; pdl?: number }): SweepCandidate[] {
    if (candles.length < 5) return [];
    const candidates: SweepCandidate[] = [];

    // Evaluate sweeps over swing highs/lows and external reference levels
    for (let i = 4; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = candles[i - 1]!;

      // 1. Look for Swing Low Sweeps (Bullish SFP / Spring)
      // Identify prior local swing low in lookback window (excluding current and prev)
      const lookbackStart = Math.max(0, i - this.config.lookbackBars);
      let localSwingLow = Infinity;
      let swingLowIdx = -1;
      for (let j = lookbackStart; j < i - 1; j++) {
        if (candles[j]!.low < localSwingLow) {
          localSwingLow = candles[j]!.low;
          swingLowIdx = j;
        }
      }

      // Check Swing Low sweep: price dips below localSwingLow, but closes back above it
      if (swingLowIdx >= 0 && localSwingLow < Infinity) {
        const swept = current.low < localSwingLow || prev.low < localSwingLow;
        const reclaimed = current.close > localSwingLow;
        const sweepLow = Math.min(current.low, prev.low);

        if (swept && reclaimed && sweepLow < localSwingLow) {
          const penetrationExcursionBps = ((localSwingLow - sweepLow) / localSwingLow) * 10000;
          const reclaimDistanceBps = ((current.close - localSwingLow) / localSwingLow) * 10000;
          const rejectionWickBps = ((current.close - current.low) / current.close) * 10000;

          if (penetrationExcursionBps >= this.config.minPenetrationBps && reclaimDistanceBps >= this.config.minReclaimBps) {
            candidates.push({
              startIndex: swingLowIdx,
              detectedIndex: i,
              subtype: "SPRING",
              wyckoffEquivalent: "SPRING",
              orientation: "UP",
              referenceLevel: localSwingLow,
              penetrationExcursionBps: Number(penetrationExcursionBps.toFixed(6)),
              reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(6)),
              rejectionWickBps: Number(rejectionWickBps.toFixed(6)),
              patternHigh: Math.max(...candles.slice(swingLowIdx, i + 1).map((c) => c.high)),
              patternLow: sweepLow,
            });
          }
        }
      }

      // 2. Look for Swing High Sweeps (Bearish SFP / Upthrust)
      let localSwingHigh = -Infinity;
      let swingHighIdx = -1;
      for (let j = lookbackStart; j < i - 1; j++) {
        if (candles[j]!.high > localSwingHigh) {
          localSwingHigh = candles[j]!.high;
          swingHighIdx = j;
        }
      }

      if (swingHighIdx >= 0 && localSwingHigh > -Infinity) {
        const swept = current.high > localSwingHigh || prev.high > localSwingHigh;
        const reclaimed = current.close < localSwingHigh;
        const sweepHigh = Math.max(current.high, prev.high);

        if (swept && reclaimed && sweepHigh > localSwingHigh) {
          const penetrationExcursionBps = ((sweepHigh - localSwingHigh) / localSwingHigh) * 10000;
          const reclaimDistanceBps = ((localSwingHigh - current.close) / localSwingHigh) * 10000;
          const rejectionWickBps = ((current.high - current.close) / current.close) * 10000;

          if (penetrationExcursionBps >= this.config.minPenetrationBps && reclaimDistanceBps >= this.config.minReclaimBps) {
            candidates.push({
              startIndex: swingHighIdx,
              detectedIndex: i,
              subtype: "UPTHRUST",
              wyckoffEquivalent: "UPTHRUST",
              orientation: "DOWN",
              referenceLevel: localSwingHigh,
              penetrationExcursionBps: Number(penetrationExcursionBps.toFixed(6)),
              reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(6)),
              rejectionWickBps: Number(rejectionWickBps.toFixed(6)),
              patternHigh: sweepHigh,
              patternLow: Math.min(...candles.slice(swingHighIdx, i + 1).map((c) => c.low)),
            });
          }
        }
      }

      // 3. PDH / PDL Sweeps if reference levels provided
      if (referenceLevels?.pdl !== undefined && referenceLevels.pdl > 0) {
        const pdl = referenceLevels.pdl;
        if (current.low < pdl && current.close > pdl) {
          const penetrationExcursionBps = ((pdl - current.low) / pdl) * 10000;
          const reclaimDistanceBps = ((current.close - pdl) / pdl) * 10000;
          const rejectionWickBps = ((current.close - current.low) / current.close) * 10000;
          if (penetrationExcursionBps >= this.config.minPenetrationBps) {
            candidates.push({
              startIndex: Math.max(0, i - 1),
              detectedIndex: i,
              subtype: "PDL_SWEEP",
              wyckoffEquivalent: "SPRING",
              orientation: "UP",
              referenceLevel: pdl,
              penetrationExcursionBps: Number(penetrationExcursionBps.toFixed(6)),
              reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(6)),
              rejectionWickBps: Number(rejectionWickBps.toFixed(6)),
              patternHigh: current.high,
              patternLow: current.low,
            });
          }
        }
      }

      if (referenceLevels?.pdh !== undefined && referenceLevels.pdh > 0) {
        const pdh = referenceLevels.pdh;
        if (current.high > pdh && current.close < pdh) {
          const penetrationExcursionBps = ((current.high - pdh) / pdh) * 10000;
          const reclaimDistanceBps = ((pdh - current.close) / pdh) * 10000;
          const rejectionWickBps = ((current.high - current.close) / current.close) * 10000;
          if (penetrationExcursionBps >= this.config.minPenetrationBps) {
            candidates.push({
              startIndex: Math.max(0, i - 1),
              detectedIndex: i,
              subtype: "PDH_SWEEP",
              wyckoffEquivalent: "UPTHRUST",
              orientation: "DOWN",
              referenceLevel: pdh,
              penetrationExcursionBps: Number(penetrationExcursionBps.toFixed(6)),
              reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(6)),
              rejectionWickBps: Number(rejectionWickBps.toFixed(6)),
              patternHigh: current.high,
              patternLow: current.low,
            });
          }
        }
      }
    }

    return candidates;
  }
}
