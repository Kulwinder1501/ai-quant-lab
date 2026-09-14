import type {
  EffortResultDetails,
  PatternOrientation,
} from "../contracts.js";
import {
  calculateVolumeMultiplier,
  calculateVolumeZScore,
  calculateZScore,
  contextWindowBars,
  type CandleLike,
} from "../pattern-context-calculator.js";

/**
 * Effort/result detection.
 *
 * ## Volume validity is a precondition, not a filter
 *
 * Every subtype below is a claim about volume, so none of them is computable on a window whose volume
 * is unknown. `calculateVolumeZScore` returns null for a window containing any non-positive volume,
 * and the guard in the loop turns that into a refusal to emit.
 *
 * This matters because the failing case is not the obvious one. An all-zero window was already
 * handled — zero variance, null z-score. The window that broke this engine straddles the 2025/2026
 * index volume break and mixes real volumes with literal zeros: large variance, a huge z-score, every
 * threshold cleared, and a `BUYING_CLIMAX` emitted for a schema change. See `volume-semantics.ts`.
 *
 * ## This family is BLOCKED (PARTIAL) upstream
 *
 * Errata Section 1 marks `EFFORT_RESULT` blocked pending exchange-traded futures volume semantics,
 * because index volume is an aggregate of constituent cash activity rather than auction volume at a
 * price. The zero-handling here makes the engine honest about what it cannot compute; it does not
 * make an index-tape climax mean what Wyckoff effort/result assumes it means. Both constraints hold.
 */

export interface EffortResultCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: EffortResultDetails["subtype"];
  orientation: PatternOrientation;
  climaxVolumeMultiplier: number | null;
  absorptionWickRatio: number | null;
  patternHigh: number;
  patternLow: number;
}

/**
 * Which wick carries the rejection claim, per subtype.
 *
 * Left to an implementer this would differ between conforming implementations, and it is a recorded
 * field, so it is pinned here and frozen in the definition registry alongside the thresholds.
 * `LOW_EFFORT_HIGH_RESULT` is null on purpose: it is a range-expansion claim and asserts nothing about
 * rejection, so any wick figure attached to it would be decorative.
 */
function rejectionWickRatio(
  candle: CandleLike,
  subtype: EffortResultDetails["subtype"],
  orientation: PatternOrientation,
): number | null {
  const range = candle.high - candle.low;
  if (!(range > 0)) return null;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  let wick: number;
  switch (subtype) {
    case "BUYING_CLIMAX":
      wick = upperWick;
      break;
    case "SELLING_CLIMAX":
      wick = lowerWick;
      break;
    case "ABSORPTION":
      wick = orientation === "UP" ? lowerWick : upperWick;
      break;
    case "HIGH_EFFORT_LOW_RESULT":
      // Direction-neutral by construction (orientation NONE), so the dominant wick is the claim.
      wick = Math.max(upperWick, lowerWick);
      break;
    case "LOW_EFFORT_HIGH_RESULT":
      return null;
  }
  return Number((wick / range).toFixed(6));
}

export class EffortResultEngine {
  detect(candles: readonly CandleLike[]): EffortResultCandidate[] {
    if (candles.length < contextWindowBars) return [];
    const candidates: EffortResultCandidate[] = [];

    const volumes = candles.map((c) => c.volume);
    const ranges = candles.map((c) => c.high - c.low);

    for (let i = contextWindowBars - 1; i < candles.length; i++) {
      const current = candles[i]!;
      const windowStart = i - (contextWindowBars - 1);
      const volWindow = volumes.slice(windowStart, i + 1);
      const rangeWindow = ranges.slice(windowStart, i + 1);

      const volZ = calculateVolumeZScore(volWindow, contextWindowBars);
      const rangeZ = calculateZScore(rangeWindow, contextWindowBars);

      // A null volume z-score means the window's volume is unknown, so no effort claim is available.
      if (volZ === null || rangeZ === null) continue;
      const climaxVolumeMultiplier = calculateVolumeMultiplier(volWindow, contextWindowBars);

      const push = (subtype: EffortResultDetails["subtype"], orientation: PatternOrientation) => {
        candidates.push({
          startIndex: i,
          detectedIndex: i,
          subtype,
          orientation,
          climaxVolumeMultiplier,
          absorptionWickRatio: rejectionWickRatio(current, subtype, orientation),
          patternHigh: current.high,
          patternLow: current.low,
        });
      };

      // 1. High Effort, Low Result (Absorption proxy): volume extremely high (>= 1.5 z), range narrow (<= 0.0 z)
      if (volZ >= 1.5 && rangeZ <= 0.0) {
        push("HIGH_EFFORT_LOW_RESULT", "NONE");
        push("ABSORPTION", current.close > (current.high + current.low) / 2 ? "UP" : "DOWN");
      }

      // 2. Buying Climax: massive volume + upper-wick rejection after a run-up
      if (volZ >= 2.0 && current.close > current.open && (current.high - current.close) >= (current.close - current.open)) {
        push("BUYING_CLIMAX", "DOWN");
      }

      // 3. Selling Climax: massive volume + lower-wick rejection after a drop
      if (volZ >= 2.0 && current.close < current.open && (current.close - current.low) >= (current.open - current.close)) {
        push("SELLING_CLIMAX", "UP");
      }

      // 4. Low Effort, High Result: range expanded (>= 1.5 z) on low volume (<= -0.5 z)
      if (rangeZ >= 1.5 && volZ <= -0.5) {
        push("LOW_EFFORT_HIGH_RESULT", current.close > current.open ? "UP" : "DOWN");
      }
    }

    return candidates;
  }
}
