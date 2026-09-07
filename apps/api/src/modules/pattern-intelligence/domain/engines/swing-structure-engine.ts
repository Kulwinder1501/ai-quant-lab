import type {
  PatternOrientation,
  SwingStructureDetails,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface SwingStructureCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: SwingStructureDetails["subtype"];
  orientation: PatternOrientation;
  swingLevel: number;
  priorSwingLevel: number;
  patternHigh: number;
  patternLow: number;
}

export interface SwingPivot {
  index: number;
  price: number;
  type: "HIGH" | "LOW";
}

export class SwingStructureEngine {
  constructor(private readonly swingWindow = 3) {}

  detect(candles: readonly CandleLike[]): SwingStructureCandidate[] {
    if (candles.length < this.swingWindow * 2 + 1) return [];
    const candidates: SwingStructureCandidate[] = [];

    // 1. Identify pivots with confirmation
    const pivots: SwingPivot[] = [];
    const w = this.swingWindow;

    for (let i = w; i < candles.length - w; i++) {
      const c = candles[i]!;
      let isHigh = true;
      let isLow = true;

      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (candles[j]!.high >= c.high) isHigh = false;
        if (candles[j]!.low <= c.low) isLow = false;
      }

      if (isHigh) {
        pivots.push({ index: i, price: c.high, type: "HIGH" });
      }
      if (isLow) {
        pivots.push({ index: i, price: c.low, type: "LOW" });
      }
    }

    // 2. Classify structural transitions and breaks of structure (BOS / CHOCH / HH / HL / LH / LL)
    let lastHighPivot: SwingPivot | null = null;
    let lastLowPivot: SwingPivot | null = null;
    let prevHighPivot: SwingPivot | null = null;
    let prevLowPivot: SwingPivot | null = null;

    for (let p = 0; p < pivots.length; p++) {
      const pivot = pivots[p]!;
      const confirmationIdx = pivot.index + w;

      if (pivot.type === "HIGH") {
        prevHighPivot = lastHighPivot;
        lastHighPivot = pivot;

        if (prevHighPivot) {
          const diff = pivot.price - prevHighPivot.price;
          const pct = Math.abs(diff / prevHighPivot.price);

          if (pct < 0.0005) {
            candidates.push({
              startIndex: prevHighPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "EQUAL_HIGH",
              orientation: "NONE",
              swingLevel: pivot.price,
              priorSwingLevel: prevHighPivot.price,
              patternHigh: pivot.price,
              patternLow: Math.min(...candles.slice(prevHighPivot.index, confirmationIdx + 1).map((c) => c.low)),
            });
          } else if (diff > 0) {
            // Higher High / BOS UP
            candidates.push({
              startIndex: prevHighPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "HIGHER_HIGH",
              orientation: "UP",
              swingLevel: pivot.price,
              priorSwingLevel: prevHighPivot.price,
              patternHigh: pivot.price,
              patternLow: Math.min(...candles.slice(prevHighPivot.index, confirmationIdx + 1).map((c) => c.low)),
            });
            candidates.push({
              startIndex: prevHighPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "BOS_UP",
              orientation: "UP",
              swingLevel: pivot.price,
              priorSwingLevel: prevHighPivot.price,
              patternHigh: pivot.price,
              patternLow: Math.min(...candles.slice(prevHighPivot.index, confirmationIdx + 1).map((c) => c.low)),
            });
          } else {
            // Lower High
            candidates.push({
              startIndex: prevHighPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "LOWER_HIGH",
              orientation: "DOWN",
              swingLevel: pivot.price,
              priorSwingLevel: prevHighPivot.price,
              patternHigh: prevHighPivot.price,
              patternLow: Math.min(...candles.slice(prevHighPivot.index, confirmationIdx + 1).map((c) => c.low)),
            });
          }
        }
      } else {
        prevLowPivot = lastLowPivot;
        lastLowPivot = pivot;

        if (prevLowPivot) {
          const diff = pivot.price - prevLowPivot.price;
          const pct = Math.abs(diff / prevLowPivot.price);

          if (pct < 0.0005) {
            candidates.push({
              startIndex: prevLowPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "EQUAL_LOW",
              orientation: "NONE",
              swingLevel: pivot.price,
              priorSwingLevel: prevLowPivot.price,
              patternHigh: Math.max(...candles.slice(prevLowPivot.index, confirmationIdx + 1).map((c) => c.high)),
              patternLow: pivot.price,
            });
          } else if (diff < 0) {
            // Lower Low / BOS DOWN
            candidates.push({
              startIndex: prevLowPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "LOWER_LOW",
              orientation: "DOWN",
              swingLevel: pivot.price,
              priorSwingLevel: prevLowPivot.price,
              patternHigh: Math.max(...candles.slice(prevLowPivot.index, confirmationIdx + 1).map((c) => c.high)),
              patternLow: pivot.price,
            });
            candidates.push({
              startIndex: prevLowPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "BOS_DOWN",
              orientation: "DOWN",
              swingLevel: pivot.price,
              priorSwingLevel: prevLowPivot.price,
              patternHigh: Math.max(...candles.slice(prevLowPivot.index, confirmationIdx + 1).map((c) => c.high)),
              patternLow: pivot.price,
            });
          } else {
            // Higher Low
            candidates.push({
              startIndex: prevLowPivot.index,
              detectedIndex: confirmationIdx,
              subtype: "HIGHER_LOW",
              orientation: "UP",
              swingLevel: pivot.price,
              priorSwingLevel: prevLowPivot.price,
              patternHigh: Math.max(...candles.slice(prevLowPivot.index, confirmationIdx + 1).map((c) => c.high)),
              patternLow: prevLowPivot.price,
            });
          }
        }
      }
    }

    return candidates;
  }
}
