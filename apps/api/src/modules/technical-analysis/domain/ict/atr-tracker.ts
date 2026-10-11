import { isFlatBar } from "../../../market-data/domain/flat-bar.js";

/**
 * Incremental Wilder ATR, computed bar-by-bar like every other tracker in this module
 * (`IctStructureTracker`, `IctZoneLedger`, `IctSessionLevelTracker`, `CisdTracker`) rather than
 * recomputed from the full candle history on every call.
 *
 * `pattern-recognition/domain/atr-series.ts` already computes the same Wilder ATR(14) convention,
 * but over the WHOLE series on every invocation -- fine for a one-shot backtest utility, wrong for
 * something called once per bar from `IctCompositeEngine.processCandle()`, which is itself called
 * with the full causal candle array on every bar of a replay. Recomputing an O(n) series there would
 * make this one new field O(n^2) over a run, the same class of defect `zones.ts`'s EQH/EQL grouping
 * and `IctLiquiditySnapshot`'s counts-not-lists change were both written to eliminate. This tracker
 * keeps O(1) state per bar instead, matching the Wilder math exactly (seed = simple average of the
 * first `period` true ranges, then `((prev * (period - 1)) + tr) / period` after).
 */
export class IctAtrTracker {
  private readonly period: number;
  private readonly seedTrueRanges: number[] = [];
  private average: number | null = null;
  private previousClose: number | null = null;

  constructor(period: number = 14) {
    this.period = period;
  }

  /**
   * Returns the current ATR after folding in this candle, or null while still warming up.
   *
   * A frozen-feed bar (`high == low && volume == 0`, see `flat-bar.ts`) is not folded in: the
   * average and the prior close stay as they were and the current ATR is returned unchanged.
   * `volume` is optional; when a caller does not supply it the bar is never treated as flat.
   *
   * The first bar of a session uses the prior session's close, so its true range can exceed its
   * own high-low range. That is the Wilder definition and is intentional.
   */
  processCandle(candle: {
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume?: number;
  }): number | null {
    if (isFlatBar(candle)) return this.average;
    const trueRange =
      this.previousClose === null
        ? candle.high - candle.low
        : Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - this.previousClose),
            Math.abs(candle.low - this.previousClose)
          );
    this.previousClose = candle.close;

    if (this.average === null) {
      this.seedTrueRanges.push(trueRange);
      if (this.seedTrueRanges.length < this.period) return null;
      this.average = this.seedTrueRanges.reduce((sum, value) => sum + value, 0) / this.period;
      return this.average;
    }

    this.average = (this.average * (this.period - 1) + trueRange) / this.period;
    return this.average;
  }
}
