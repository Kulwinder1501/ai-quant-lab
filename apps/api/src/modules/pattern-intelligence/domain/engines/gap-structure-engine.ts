import type {
  GapStructureDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface GapStructureCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: GapStructureDetails["subtype"];
  orientation: PatternOrientation;
  gapBps: number;
  gapVsAtr: number;
  gapDirectionVsPriorRange: "ABOVE_RANGE" | "BELOW_RANGE" | "INSIDE_RANGE";
  priorDayHigh: number;
  priorDayLow: number;
  patternHigh: number;
  patternLow: number;
}

export class GapStructureEngine {
  detect(
    candles: readonly CandleLike[],
    atrSeries: readonly (number | null)[],
    priorDayLevels?: { pdh: number; pdl: number; pdc: number },
  ): GapStructureCandidate[] {
    if (candles.length < 2) return [];
    const candidates: GapStructureCandidate[] = [];

    // Find day transitions
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = candles[i - 1]!;

      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const prevDay = new Date(prev.openTime.getTime() + istOffsetMs).toISOString().slice(0, 10);
      const currDay = new Date(current.openTime.getTime() + istOffsetMs).toISOString().slice(0, 10);

      const isSessionOpen = prevDay !== currDay;
      if (!isSessionOpen) continue;

      const pdh = priorDayLevels?.pdh ?? prev.high;
      const pdl = priorDayLevels?.pdl ?? prev.low;
      const pdc = priorDayLevels?.pdc ?? prev.close;

      // No ATR substitute. The prior-day range stood in for an unavailable ATR here, and `gapVsAtr`
      // is not merely recorded -- BREAKAWAY_GAP fires on `abs(gapVsAtr) >= 1.0`, so the substitution
      // decided *which patterns existed* during warmup, against a denominator that was never ATR.
      // Errata Section 3: refuse to emit instead.
      const atr = atrSeries[i];
      if (atr === null || atr === undefined || !(atr > 0)) continue;
      if (!(pdc > 0)) continue;
      const gapPoints = current.open - pdc;
      const gapBps = (gapPoints / pdc) * 10000;
      const gapVsAtr = gapPoints / atr;

      let gapDirectionVsPriorRange: "ABOVE_RANGE" | "BELOW_RANGE" | "INSIDE_RANGE" = "INSIDE_RANGE";
      if (current.open > pdh) gapDirectionVsPriorRange = "ABOVE_RANGE";
      else if (current.open < pdl) gapDirectionVsPriorRange = "BELOW_RANGE";

      // 1. Gap and Go: Gapped above PDH and continued in same direction (close > open)
      if (gapDirectionVsPriorRange === "ABOVE_RANGE" && current.close > current.open) {
        candidates.push({
          startIndex: i - 1,
          detectedIndex: i,
          subtype: "GAP_AND_GO",
          orientation: "UP",
          gapBps: Number(gapBps.toFixed(6)),
          gapVsAtr: Number(gapVsAtr.toFixed(6)),
          gapDirectionVsPriorRange,
          priorDayHigh: pdh,
          priorDayLow: pdl,
          patternHigh: current.high,
          patternLow: pdl,
        });
      } else if (gapDirectionVsPriorRange === "BELOW_RANGE" && current.close < current.open) {
        candidates.push({
          startIndex: i - 1,
          detectedIndex: i,
          subtype: "GAP_AND_GO",
          orientation: "DOWN",
          gapBps: Number(gapBps.toFixed(6)),
          gapVsAtr: Number(gapVsAtr.toFixed(6)),
          gapDirectionVsPriorRange,
          priorDayHigh: pdh,
          priorDayLow: pdl,
          patternHigh: pdh,
          patternLow: current.low,
        });
      }

      // 2. Gap and Fade: Gapped above PDH but faded down towards PDC
      if (gapDirectionVsPriorRange === "ABOVE_RANGE" && current.close < current.open) {
        candidates.push({
          startIndex: i - 1,
          detectedIndex: i,
          subtype: "GAP_AND_FADE",
          orientation: "DOWN",
          gapBps: Number(gapBps.toFixed(6)),
          gapVsAtr: Number(gapVsAtr.toFixed(6)),
          gapDirectionVsPriorRange,
          priorDayHigh: pdh,
          priorDayLow: pdl,
          patternHigh: current.high,
          patternLow: pdl,
        });
      } else if (gapDirectionVsPriorRange === "BELOW_RANGE" && current.close > current.open) {
        candidates.push({
          startIndex: i - 1,
          detectedIndex: i,
          subtype: "GAP_AND_FADE",
          orientation: "UP",
          gapBps: Number(gapBps.toFixed(6)),
          gapVsAtr: Number(gapVsAtr.toFixed(6)),
          gapDirectionVsPriorRange,
          priorDayHigh: pdh,
          priorDayLow: pdl,
          patternHigh: pdh,
          patternLow: current.low,
        });
      }

      // 3. Breakaway Gap (Significant gap > 1.0 ATR outside range)
      if (Math.abs(gapVsAtr) >= 1.0) {
        candidates.push({
          startIndex: i - 1,
          detectedIndex: i,
          subtype: "BREAKAWAY_GAP",
          orientation: gapPoints > 0 ? "UP" : "DOWN",
          gapBps: Number(gapBps.toFixed(6)),
          gapVsAtr: Number(gapVsAtr.toFixed(6)),
          gapDirectionVsPriorRange,
          priorDayHigh: pdh,
          priorDayLow: pdl,
          patternHigh: Math.max(pdh, current.high),
          patternLow: Math.min(pdl, current.low),
        });
      }
    }

    return candidates;
  }
}
