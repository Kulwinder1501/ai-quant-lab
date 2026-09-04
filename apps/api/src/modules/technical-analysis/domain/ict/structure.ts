import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import { findConfirmedPivotAt } from "./causal-pivot.js";

export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface StructureEvent {
  readonly type: "BOS" | "CHOCH" | "IDM_CONFIRMED" | "SWEEP";
  readonly direction: "BULLISH" | "BEARISH";
  readonly level: number;
  readonly candleIndex: number;
  readonly candleTime: Date;
  readonly brokenPivot: ConfirmedPivot;
  readonly isWickOnly: boolean; // true = sweep, false = confirmed body close
}

export interface IctStructureSnapshot {
  readonly trend: TrendDirection;
  readonly lastHH: ConfirmedPivot | null;
  readonly lastHL: ConfirmedPivot | null;
  readonly lastLL: ConfirmedPivot | null;
  readonly lastLH: ConfirmedPivot | null;
  readonly idm: ConfirmedPivot | null;
  readonly bosLevel: number | null;
  readonly chochLevel: number | null;
  readonly internalVsExternal: "INTERNAL" | "EXTERNAL";
  readonly lastEvent: StructureEvent | null;
  readonly confirmedPivots: readonly ConfirmedPivot[];
}

export interface MergedCandle extends CausalCandle {
  readonly mergedCandleIds: readonly string[];
  readonly isInsideBarMerged: boolean;
}

/**
 * Pre-pass: Indian Gap as one candle & Inside-bar merge.
 * If candle i is completely inside candle i-1 (high <= prev.high && low >= prev.low),
 * it is merged into candle i-1 according to lecture rules.
 */
export function mergeInsideBars(candles: readonly CausalCandle[]): MergedCandle[] {
  if (candles.length === 0) return [];
  const merged: MergedCandle[] = [];

  for (const candle of candles) {
    if (merged.length === 0) {
      merged.push({
        ...candle,
        mergedCandleIds: [candle.id],
        isInsideBarMerged: false,
      });
      continue;
    }

    const prev = merged[merged.length - 1];
    const isInside = candle.high <= prev.high && candle.low >= prev.low;

    if (isInside) {
      merged[merged.length - 1] = {
        ...prev,
        close: candle.close,
        volume: prev.volume + candle.volume,
        mergedCandleIds: [...prev.mergedCandleIds, candle.id],
        isInsideBarMerged: true,
      };
    } else {
      merged.push({
        ...candle,
        mergedCandleIds: [candle.id],
        isInsideBarMerged: false,
      });
    }
  }

  return merged;
}

export class IctStructureTracker {
  private trend: TrendDirection = "NEUTRAL";
  private lastHH: ConfirmedPivot | null = null;
  private lastHL: ConfirmedPivot | null = null;
  private lastLL: ConfirmedPivot | null = null;
  private lastLH: ConfirmedPivot | null = null;

  // Active unconfirmed extreme (candidate waiting for IDM confirmation)
  private unconfirmedHigh: ConfirmedPivot | null = null;
  private unconfirmedLow: ConfirmedPivot | null = null;

  // Most recent internal swings (candidates for IDM)
  private activeIdm: ConfirmedPivot | null = null;
  private lastInternalLow: ConfirmedPivot | null = null;
  private lastInternalHigh: ConfirmedPivot | null = null;
  private confirmedPivots: ConfirmedPivot[] = [];

  constructor(private readonly pivotLength: number = 3) {}

  processCandle(candles: readonly CausalCandle[], currentIndex: number): IctStructureSnapshot {
    let currentEvent: StructureEvent | null = null;
    const current = candles[currentIndex];
    const pivots = findConfirmedPivotAt(candles, currentIndex, this.pivotLength);

    // 1. If a swing low was confirmed at this bar
    if (pivots.low) {
      this.confirmedPivots.push(pivots.low);
      this.lastInternalLow = pivots.low;
      if (this.trend === "BULLISH" && this.unconfirmedHigh) {
        if (!this.activeIdm || pivots.low.index > this.activeIdm.index) {
          this.activeIdm = pivots.low;
        }
      } else if (this.trend === "NEUTRAL") {
        this.unconfirmedLow = pivots.low;
        if (!this.lastHL) this.lastHL = pivots.low;
      }
    }

    // 2. If a swing high was confirmed at this bar
    if (pivots.high) {
      this.confirmedPivots.push(pivots.high);
      this.lastInternalHigh = pivots.high;
      if (this.trend === "BEARISH" && this.unconfirmedLow) {
        if (!this.activeIdm || pivots.high.index > this.activeIdm.index) {
          this.activeIdm = pivots.high;
        }
      } else if (this.trend === "NEUTRAL") {
        this.unconfirmedHigh = pivots.high;
        if (!this.lastHH) {
          this.lastHH = pivots.high;
          this.trend = "BULLISH";
        }
      }
    }

    // Update unconfirmed extremes
    if (pivots.high && this.trend === "BULLISH") {
      if (!this.unconfirmedHigh || pivots.high.price > this.unconfirmedHigh.price) {
        this.unconfirmedHigh = pivots.high;
      }
    }

    if (pivots.low && this.trend === "BEARISH") {
      if (!this.unconfirmedLow || pivots.low.price < this.unconfirmedLow.price) {
        this.unconfirmedLow = pivots.low;
      }
    }

    // 3. Check IDM tap/sweep
    if (this.activeIdm) {
      if (this.trend === "BULLISH" && this.activeIdm.type === "LOW") {
        if (current.low <= this.activeIdm.price) {
          if (this.unconfirmedHigh) {
            this.lastHH = this.unconfirmedHigh;
            this.unconfirmedHigh = null;
          }
          currentEvent = {
            type: "IDM_CONFIRMED",
            direction: "BULLISH",
            level: this.activeIdm.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.activeIdm,
            isWickOnly: current.close > this.activeIdm.price,
          };
          this.activeIdm = null;
        }
      } else if (this.trend === "BEARISH" && this.activeIdm.type === "HIGH") {
        if (current.high >= this.activeIdm.price) {
          if (this.unconfirmedLow) {
            this.lastLL = this.unconfirmedLow;
            this.unconfirmedLow = null;
          }
          currentEvent = {
            type: "IDM_CONFIRMED",
            direction: "BEARISH",
            level: this.activeIdm.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.activeIdm,
            isWickOnly: current.close < this.activeIdm.price,
          };
          this.activeIdm = null;
        }
      }
    }

    // 4. Check BOS / CHoCH / Sweeps
    if (this.trend === "BULLISH") {
      if (this.lastHH && current.high > this.lastHH.price) {
        if (current.close > this.lastHH.price) {
          if (this.lastInternalLow) {
            this.lastHL = this.lastInternalLow;
          }
          currentEvent = {
            type: "BOS",
            direction: "BULLISH",
            level: this.lastHH.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastHH,
            isWickOnly: false,
          };
          this.lastHH = null;
        } else {
          currentEvent = {
            type: "SWEEP",
            direction: "BULLISH",
            level: this.lastHH.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastHH,
            isWickOnly: true,
          };
        }
      }

      if (this.lastHL && current.low < this.lastHL.price) {
        if (current.close < this.lastHL.price) {
          this.trend = "BEARISH";
          this.lastLH = this.lastHH;
          currentEvent = {
            type: "CHOCH",
            direction: "BEARISH",
            level: this.lastHL.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastHL,
            isWickOnly: false,
          };
          this.lastHL = null;
        } else {
          currentEvent = {
            type: "SWEEP",
            direction: "BEARISH",
            level: this.lastHL.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastHL,
            isWickOnly: true,
          };
        }
      }
    } else if (this.trend === "BEARISH") {
      if (this.lastLL && current.low < this.lastLL.price) {
        if (current.close < this.lastLL.price) {
          if (this.lastInternalHigh) {
            this.lastLH = this.lastInternalHigh;
          }
          currentEvent = {
            type: "BOS",
            direction: "BEARISH",
            level: this.lastLL.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastLL,
            isWickOnly: false,
          };
          this.lastLL = null;
        } else {
          currentEvent = {
            type: "SWEEP",
            direction: "BEARISH",
            level: this.lastLL.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastLL,
            isWickOnly: true,
          };
        }
      }

      if (this.lastLH && current.high > this.lastLH.price) {
        if (current.close > this.lastLH.price) {
          this.trend = "BULLISH";
          this.lastHL = this.lastLL;
          currentEvent = {
            type: "CHOCH",
            direction: "BULLISH",
            level: this.lastLH.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastLH,
            isWickOnly: false,
          };
          this.lastLH = null;
        } else {
          currentEvent = {
            type: "SWEEP",
            direction: "BULLISH",
            level: this.lastLH.price,
            candleIndex: currentIndex,
            candleTime: current.openTime,
            brokenPivot: this.lastLH,
            isWickOnly: true,
          };
        }
      }
    }

    return {
      trend: this.trend,
      lastHH: this.lastHH,
      lastHL: this.lastHL,
      lastLL: this.lastLL,
      lastLH: this.lastLH,
      idm: this.activeIdm,
      bosLevel: this.trend === "BULLISH" ? (this.lastHH?.price ?? null) : (this.lastLL?.price ?? null),
      chochLevel: this.trend === "BULLISH" ? (this.lastHL?.price ?? null) : (this.lastLH?.price ?? null),
      internalVsExternal: this.activeIdm !== null ? "INTERNAL" : "EXTERNAL",
      lastEvent: currentEvent,
      confirmedPivots: this.confirmedPivots,
    };
  }
}
