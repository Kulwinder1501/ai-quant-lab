import { istSessionDate } from "../../../platform/calendar/trading-session.js";
import type { CausalCandle } from "./causal-pivot.js";
import type { IctStructureSnapshot } from "./structure.js";
import type { SessionLevelsSnapshot } from "./session-levels.js";

export type IctBiasDirection = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
export type DailyPathTemplate = "OLHC" | "OHLC" | "CONSOLIDATION" | "UNKNOWN";

export interface DealingRange {
  readonly rangeHigh: number;
  readonly rangeLow: number;
  readonly equilibrium: number;
  readonly isPremium: (price: number) => boolean;
  readonly isDiscount: (price: number) => boolean;
}

export interface IctBiasSnapshot {
  readonly bias: IctBiasDirection;
  readonly dailyTemplate: DailyPathTemplate;
  readonly dealingRange: DealingRange | null;
  readonly reasons: readonly string[];
}

export class IctBiasTracker {
  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    structure: IctStructureSnapshot,
    sessionLevels: SessionLevelsSnapshot
  ): IctBiasSnapshot {
    const current = candles[currentIndex];
    const currentDate = sessionLevels.currentSessionDate;
    const reasons: string[] = [];

    // 1. Analyze intraday path (from start of current session)
    let sessionStartIndex = currentIndex;
    while (
      sessionStartIndex > 0 &&
      istSessionDate(candles[sessionStartIndex - 1].openTime) === currentDate
    ) {
      sessionStartIndex--;
    }

    const sessionCandles = candles.slice(sessionStartIndex, currentIndex + 1);
    let dailyTemplate: DailyPathTemplate = "UNKNOWN";

    if (sessionCandles.length >= 3) {
      let highIdx = 0;
      let lowIdx = 0;
      let maxH = -Infinity;
      let minL = Infinity;

      for (let i = 0; i < sessionCandles.length; i++) {
        if (sessionCandles[i].high > maxH) {
          maxH = sessionCandles[i].high;
          highIdx = i;
        }
        if (sessionCandles[i].low < minL) {
          minL = sessionCandles[i].low;
          lowIdx = i;
        }
      }

      if (lowIdx < highIdx) {
        dailyTemplate = "OLHC"; // Open -> Low formed first -> High formed -> Bullish template
      } else if (highIdx < lowIdx) {
        dailyTemplate = "OHLC"; // Open -> High formed first -> Low formed -> Bearish template
      } else {
        dailyTemplate = "CONSOLIDATION";
      }
    }

    // 2. Derive Bias from Structure + Session Liquidity Sweeps
    let bias: IctBiasDirection = "UNKNOWN";

    // A. Prior Session Level sweep has high predictive weight for day's bias
    const sweep = sessionLevels.lastSweepEvent;
    if (sweep && sweep.eventType === "SWEEP") {
      if (sweep.levelType === "PDL") {
        bias = "BULLISH";
        reasons.push("Prior Day Low (SSL) swept and reclaimed -> Bullish expansion expected");
      } else if (sweep.levelType === "PDH") {
        bias = "BEARISH";
        reasons.push("Prior Day High (BSL) swept and rejected -> Bearish expansion expected");
      }
    }

    // B. If no active sweep event, defer to confirmed structural trend
    if (bias === "UNKNOWN") {
      if (structure.trend === "BULLISH") {
        bias = "BULLISH";
        reasons.push("Confirmed Bullish Market Structure (BOS/HH/HL)");
      } else if (structure.trend === "BEARISH") {
        bias = "BEARISH";
        reasons.push("Confirmed Bearish Market Structure (BOS/LH/LL)");
      } else if (dailyTemplate === "UNKNOWN") {
        // No sweep, no structural trend, and too little session history to
        // resolve the intraday path: evidence is absent, not directionless.
        bias = "UNKNOWN";
        reasons.push("Insufficient session history to resolve path or structure -> bias unknown");
      } else {
        // The session path has formed and structure is genuinely ranging: the
        // engine ran on sufficient evidence and found no directional edge.
        bias = "NEUTRAL";
        reasons.push("Session path formed but structure is ranging -> no directional edge");
      }
    }

    // 3. Compute Dealing Range
    let dealingRange: DealingRange | null = null;
    let rangeHigh: number | null = null;
    let rangeLow: number | null = null;

    if (structure.lastHH && structure.lastHL) {
      rangeHigh = structure.lastHH.price;
      rangeLow = structure.lastHL.price;
    } else if (structure.lastLH && structure.lastLL) {
      rangeHigh = structure.lastLH.price;
      rangeLow = structure.lastLL.price;
    } else if (sessionLevels.levels) {
      rangeHigh = sessionLevels.levels.pdh;
      rangeLow = sessionLevels.levels.pdl;
    }

    if (rangeHigh !== null && rangeLow !== null && rangeHigh > rangeLow) {
      const eq = (rangeHigh + rangeLow) / 2;
      dealingRange = {
        rangeHigh,
        rangeLow,
        equilibrium: eq,
        isPremium: (price: number) => price >= eq,
        isDiscount: (price: number) => price < eq,
      };
    }

    return {
      bias,
      dailyTemplate,
      dealingRange,
      reasons,
    };
  }
}
