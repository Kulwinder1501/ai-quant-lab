import type { CausalCandle } from "./causal-pivot.js";

/**
 * CISD -- Change in State of Delivery.
 *
 * Researched against source material before implementation (not inferred from memory), across three
 * references, one revisited twice with a disambiguating worked example after the first two appeared
 * to conflict:
 *   - https://innercircletrader.net/tutorials/ict-change-in-the-state-of-delivery/
 *   - https://liquidityscan.io/blog/what-is-cisd-change-in-state-of-delivery-ict
 *   - https://innercircletrader.net/tutorials/powerful-ict-reversal-patterns/
 *
 * The doctrine, precisely: within a "delivery leg" -- a run of one or more consecutive same-direction
 * candles immediately preceding a reversal -- CISD confirms the moment a candle in the NEW direction
 * *closes* beyond the leg's own opening price. One point is unambiguous across all three sources:
 *
 *   Only the body close counts. "A wick poke past the opposing leg's open is not a CISD -- only a
 *   body close is." High/low are never read here, only close vs. the frozen open level.
 *
 * ## The first-candle-vs-last-candle question is NOT settled by the source material
 *
 * For a MULTI-candle leg, which candle's open is "the" reference is a genuine, acknowledged
 * ambiguity in the retail teaching material, not a detail this file got wrong through carelessness.
 * The first two sources read as "the run's own first candle" ("mark the opening price of that
 * run... where the run began"). The third source, describing CISD as one stage inside a larger
 * reversal framework, uses looser language ("the body of the last opposing candle before
 * consecutive directional candles") that points the other way. Pressed with a specific worked
 * numeric example, the canonical source's own answer was: "The article does not explicitly specify
 * whether this refers to the first or last candle's open when multiple candles form the delivery
 * leg... this detail leaves this detail unresolved" -- the ambiguity is IN the doctrine as commonly
 * taught, not resolved by reading more of it.
 *
 * This implementation takes the FIRST-candle reading, as the more explicit and more frequently
 * stated of the two, and because it is the reading that keeps CISD conceptually distinct from this
 * codebase's own order-block candle selection (`findOrderBlockCandle` in zones.ts, which already
 * picks the LAST opposing candle before displacement, for a different, already-measured purpose --
 * see "Deliberately separate" below). But it is a choice, not a proven fact, and the two readings
 * only differ when a leg is 2+ candles long. If this arm's own measurement (see the falsification
 * program doc) is ever revisited, the last-candle reading is the first alternative worth testing as
 * its own configuration, not a silent replacement.
 *
 * ## Single-generation tracking, not a stack
 *
 * Both sources describe the reference leg as "the run... immediately preceding the reversal" --
 * singular, most recent. Verified by construction (see cisd.test.ts, scenario 4): a direction flip
 * that never confirms a CISD still discards whatever was pending and replaces it with the run that
 * just ended. There is no multi-generation memory of earlier failed attempts; each new reversal is
 * tested only against the one leg immediately before it. A failed 1-candle pullback is itself a
 * valid leg by the same rule ("a single candle or a series" -- no minimum-significance filter exists
 * in the source rules), so small, low-significance CISDs fire constantly on their own; this module
 * does not filter for relevance. That filtering (POI tap, HTF bias alignment) is the strategy layer's
 * job, exactly as both sources emphasise: "CISD on its own is just a candle close... inside a tap of
 * a daily or 4-hour PD Array, that same close is a high-probability reversal trigger" -- and the
 * corollary, "filter every CISD through daily bias; CISD against higher-timeframe bias statistically
 * fails more often", which is the same asymmetric with-trend/counter-trend treatment `bias.ts` already
 * gives session liquidity sweeps.
 *
 * ## Deliberately separate from zones.ts's order-block construction
 *
 * The doctrine also says the delivery leg, once CISD confirms, becomes the order block for that move.
 * This module does not attempt that merge. `zones.ts`'s order block is anchored to a single candle
 * found by backward search from the displacement leg and is measured, tested, and consumed by
 * `ict-structure-strategy.ts` already; conflating it with a multi-candle CISD leg (which can span a
 * different candle range entirely) would change an existing, working construction to accommodate a
 * new, unmeasured one. `CisdEvent` carries `legStartIndex`/`legEndIndex` so a future, explicitly
 * measured "CISD leg as its own zone" construction has what it needs without touching zones.ts.
 */

export interface CisdEvent {
  /** Direction of the NEW delivery this event confirms -- i.e. which side just started, not the leg that broke. */
  readonly direction: "BULLISH" | "BEARISH";
  /** The violated leg's own opening price -- its first candle's open, never its last. */
  readonly triggerLevel: number;
  /** Index of the leg's first candle. */
  readonly legStartIndex: number;
  /** Index of the leg's last candle, immediately before the reversal run began. */
  readonly legEndIndex: number;
  readonly confirmingCandleIndex: number;
  readonly confirmingCandleTime: Date;
}

interface PendingLeg {
  readonly direction: "UP" | "DOWN";
  readonly openPrice: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

/**
 * Strictly causal, single-pass CISD tracker: one call per bar, in chronological order, mirroring
 * `IctStructureTracker.processCandle`'s calling convention. Returns the event confirmed on THIS bar,
 * or null.
 */
export class CisdTracker {
  private runDirection: "UP" | "DOWN" | null = null;
  private runStartIndex: number | null = null;
  private pendingLeg: PendingLeg | null = null;

  processCandle(candles: readonly CausalCandle[], currentIndex: number): CisdEvent | null {
    const current = candles[currentIndex];

    /*
     * A flat candle (close === open) delivers in neither direction, so it neither extends nor
     * reverses the current run -- it inherits the run's existing direction, which is a no-op for run
     * tracking. On the very first candle of a series, with no run established yet, a flat candle
     * establishes nothing and this bar produces no event; the next directional candle starts the
     * first run normally.
     */
    const dir: "UP" | "DOWN" | null =
      current.close > current.open ? "UP" : current.close < current.open ? "DOWN" : this.runDirection;
    if (dir === null) return null;

    if (this.runDirection === null) {
      this.runDirection = dir;
      this.runStartIndex = currentIndex;
    } else if (dir !== this.runDirection) {
      // The run that is ending becomes the sole reference CISD is tested against, discarding
      // whatever was pending before -- single-generation tracking, see the file docstring.
      this.pendingLeg = {
        direction: this.runDirection,
        openPrice: candles[this.runStartIndex!].open,
        startIndex: this.runStartIndex!,
        endIndex: currentIndex - 1,
      };
      this.runDirection = dir;
      this.runStartIndex = currentIndex;
    }

    if (this.pendingLeg !== null && this.pendingLeg.direction !== dir) {
      const crossed = this.pendingLeg.direction === "DOWN"
        ? current.close > this.pendingLeg.openPrice
        : current.close < this.pendingLeg.openPrice;
      if (crossed) {
        const event: CisdEvent = {
          direction: this.pendingLeg.direction === "DOWN" ? "BULLISH" : "BEARISH",
          triggerLevel: this.pendingLeg.openPrice,
          legStartIndex: this.pendingLeg.startIndex,
          legEndIndex: this.pendingLeg.endIndex,
          confirmingCandleIndex: currentIndex,
          confirmingCandleTime: current.openTime,
        };
        this.pendingLeg = null; // fires at most once per leg transition
        return event;
      }
    }

    return null;
  }
}
