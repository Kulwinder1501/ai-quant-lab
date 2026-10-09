import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import type { SessionSweepEvent } from "./session-levels.js";
import type { IctCausalEvent } from "./zones.js";

/**
 * MSS -- Market Structure Shift, with displacement, preceded by a liquidity sweep.
 *
 * This is the ICT reversal trigger, and it is deliberately NOT the same thing as `structure.ts`'s
 * BOS/CHoCH. Those are body-close breaks inside an IDM-centred trend model; they say nothing about
 * HOW the break happened. The doctrine's MSS is a three-part sequence, in this order:
 *
 *   1. LIQUIDITY IS TAKEN. Price wicks through a resting pool -- a confirmed swing low (sell-side) or
 *      high (buy-side), or the previous day's low/high -- and CLOSES back on the other side of it.
 *      Without this there was no stop-run, so the "shift" that follows is just a continuation break.
 *   2. THE OPPOSING SWING BREAKS ON A BODY CLOSE. After the sell-side sweep, price closes above the
 *      most recent swing high that preceded the sweep (mirror image for a bearish shift). That
 *      swing is the one that was made by the move which ran the stops, so breaking it is the first
 *      evidence the delivery has changed direction.
 *   3. IT IS A DISPLACEMENT. The breaking candle is a strong, one-directional candle (body of at
 *      least `displacementMinAtr` x ATR, closing in the direction of the break), not a drift
 *      through the level. A fair value gap left behind is recorded as a covariate (`hasFvg`) rather
 *      than demanded, because a 3-bar gap needs the NEXT bar to exist.
 *
 * The event also carries the LEG: from the sweep extreme (where the move began) to the running
 * extreme since the break. That leg -- not the engine's HH/HL dealing range -- is what the doctrine
 * measures OTE retracement on, and its start is the protective level for the trade.
 *
 * Causality: everything here is evaluated at a completed bar. The pivots passed in are the
 * already-confirmed ones (right wing closed); a pivot is never "predicted". The leg's far end moves
 * only forward in time and the snapshot handed out for a bar is a fresh immutable object, so a
 * stored snapshot never changes underneath a reader (the same copy-on-write rule `zones.ts` follows).
 *
 * Single active shift: a newer shift replaces the previous one. Invalidation is a body close
 * beyond the sweep extreme, at which point the shift is gone (null), not marked.
 */

export type MssDirection = "BULLISH" | "BEARISH";

export interface MssSnapshot extends IctCausalEvent {
  readonly direction: MssDirection;
  /** The swing level whose body-close break defines the shift. */
  readonly brokenLevel: number;
  readonly brokenPivotTime: Date;
  readonly sweepBarIndex: number;
  /** Where the leg started: lowest low (bullish) / highest high (bearish) from the sweep onward. Also the protective level. */
  readonly legStart: number;
  /** The running far end of the leg: highest high (bullish) / lowest low (bearish) since the sweep. */
  readonly legEnd: number;
  readonly breakBarIndex: number;
  readonly breakBarTime: Date;
  /** Body of the breaking candle in ATR units, at the break bar. */
  readonly displacementBodyAtr: number;
  /** Whether the breaking candle left a 3-bar fair value gap (candle 1 high < candle 3 low for bullish). */
  readonly hasFvg: boolean;
  /** Bars elapsed since the break bar, as of this snapshot. 0 on the break bar. */
  readonly barsSinceBreak: number;
  /** What kind of pool was taken before the shift. */
  readonly sweptKind: "SWING" | "PDH" | "PDL";
}

interface PendingSweep {
  readonly barIndex: number;
  readonly kind: "SWING" | "PDH" | "PDL";
  /** Extreme since (and including) the sweep bar: min low for a bullish sweep, max high for bearish. */
  extreme: number;
}

export interface MssConfig {
  /** Breaking candle body must be at least this many ATR. */
  readonly displacementMinAtr: number;
  /** A sweep stays eligible to be followed by a shift for this many bars. */
  readonly sweepLookbackBars: number;
  /** How many of the most recent confirmed pivots are examined for a swept pool. */
  readonly pivotScanDepth: number;
}

export const defaultMssConfig: MssConfig = {
  displacementMinAtr: 0.8,
  sweepLookbackBars: 10,
  pivotScanDepth: 6,
};

const LATEST_PIVOT_SCAN_DEPTH = 40;

type ActiveShift = Omit<MssSnapshot, "barsSinceBreak">;

export class MssTracker {
  private active: ActiveShift | null = null;
  private pendingBullishSweep: PendingSweep | null = null;
  private pendingBearishSweep: PendingSweep | null = null;

  constructor(private readonly config: MssConfig = defaultMssConfig) {}

  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    pivots: readonly ConfirmedPivot[],
    atr: number | null,
    sessionSweep: SessionSweepEvent | null
  ): MssSnapshot | null {
    const c = candles[currentIndex];

    // 1. Carry the active shift forward: invalidate on a body close beyond its start, else extend the leg.
    if (this.active !== null) {
      const a = this.active;
      const broken = a.direction === "BULLISH" ? c.close < a.legStart : c.close > a.legStart;
      if (broken) {
        this.active = null;
      } else {
        this.active = {
          ...a,
          legEnd: a.direction === "BULLISH" ? Math.max(a.legEnd, c.high) : Math.min(a.legEnd, c.low),
        };
      }
    }

    // 2. Age out stale sweeps, then fold this bar into the surviving ones' extremes.
    const lookback = this.config.sweepLookbackBars;
    if (this.pendingBullishSweep && currentIndex - this.pendingBullishSweep.barIndex > lookback) {
      this.pendingBullishSweep = null;
    }
    if (this.pendingBearishSweep && currentIndex - this.pendingBearishSweep.barIndex > lookback) {
      this.pendingBearishSweep = null;
    }
    if (this.pendingBullishSweep) {
      this.pendingBullishSweep.extreme = Math.min(this.pendingBullishSweep.extreme, c.low);
    }
    if (this.pendingBearishSweep) {
      this.pendingBearishSweep.extreme = Math.max(this.pendingBearishSweep.extreme, c.high);
    }

    // 3. Did this bar take liquidity? Wick through a pool and close back on the other side of it.
    const sweptLow = this.findSweptPivot(pivots, "LOW", c, currentIndex);
    if (sweptLow) {
      this.pendingBullishSweep = { barIndex: currentIndex, kind: "SWING", extreme: c.low };
    }
    const sweptHigh = this.findSweptPivot(pivots, "HIGH", c, currentIndex);
    if (sweptHigh) {
      this.pendingBearishSweep = { barIndex: currentIndex, kind: "SWING", extreme: c.high };
    }
    if (sessionSweep && sessionSweep.eventType === "SWEEP" && sessionSweep.barIndex === currentIndex) {
      if (sessionSweep.levelType === "PDL") {
        this.pendingBullishSweep = { barIndex: currentIndex, kind: "PDL", extreme: c.low };
      } else {
        this.pendingBearishSweep = { barIndex: currentIndex, kind: "PDH", extreme: c.high };
      }
    }

    // 4. Shift: displacement body close through the swing that preceded the sweep.
    if (atr !== null && atr > 0) {
      const body = Math.abs(c.close - c.open);
      const displaced = body >= this.config.displacementMinAtr * atr;

      if (displaced && c.close > c.open && this.pendingBullishSweep) {
        const sweep = this.pendingBullishSweep;
        const ref = latestPivotBefore(pivots, "HIGH", sweep.barIndex, currentIndex);
        if (ref && c.close > ref.price) {
          this.active = this.buildShift("BULLISH", candles, currentIndex, ref, sweep, body / atr);
          this.pendingBullishSweep = null;
        }
      } else if (displaced && c.close < c.open && this.pendingBearishSweep) {
        const sweep = this.pendingBearishSweep;
        const ref = latestPivotBefore(pivots, "LOW", sweep.barIndex, currentIndex);
        if (ref && c.close < ref.price) {
          this.active = this.buildShift("BEARISH", candles, currentIndex, ref, sweep, body / atr);
          this.pendingBearishSweep = null;
        }
      }
    }

    if (this.active === null) return null;
    return { ...this.active, barsSinceBreak: currentIndex - this.active.breakBarIndex };
  }

  private buildShift(
    direction: MssDirection,
    candles: readonly CausalCandle[],
    currentIndex: number,
    ref: ConfirmedPivot,
    sweep: PendingSweep,
    bodyAtr: number
  ): ActiveShift {
    const c = candles[currentIndex];
    const hasFvg =
      currentIndex >= 2 &&
      (direction === "BULLISH"
        ? c.low > candles[currentIndex - 2].high
        : c.high < candles[currentIndex - 2].low);
    const barOpen = c.openTime.getTime();
    return {
      direction,
      brokenLevel: ref.price,
      brokenPivotTime: ref.time,
      sweepBarIndex: sweep.barIndex,
      legStart: sweep.extreme,
      legEnd: direction === "BULLISH" ? c.high : c.low,
      breakBarIndex: currentIndex,
      breakBarTime: c.openTime,
      displacementBodyAtr: bodyAtr,
      hasFvg,
      sweptKind: sweep.kind,
      candidateAt: candles[sweep.barIndex].openTime.getTime(),
      formedAt: ref.time.getTime(),
      confirmedAt: barOpen,
      availableAt: barOpen,
    };
  }

  /**
   * The most recent of the last few confirmed pivots of `type` that this bar wicked through and
   * closed back across. Only pivots already confirmed AND formed before this bar can be swept by it.
   */
  private findSweptPivot(
    pivots: readonly ConfirmedPivot[],
    type: "HIGH" | "LOW",
    c: CausalCandle,
    currentIndex: number
  ): ConfirmedPivot | null {
    let seen = 0;
    for (let i = pivots.length - 1; i >= 0 && seen < this.config.pivotScanDepth; i -= 1) {
      const p = pivots[i];
      if (p.type !== type) continue;
      seen += 1;
      if (p.index >= currentIndex || p.confirmedAtIndex > currentIndex) continue;
      if (type === "LOW" && c.low < p.price && c.close > p.price) return p;
      if (type === "HIGH" && c.high > p.price && c.close < p.price) return p;
    }
    return null;
  }
}

/** The latest confirmed pivot of `type` whose candle precedes `beforeIndex` and that is known by `knownByIndex`. */
function latestPivotBefore(
  pivots: readonly ConfirmedPivot[],
  type: "HIGH" | "LOW",
  beforeIndex: number,
  knownByIndex: number
): ConfirmedPivot | null {
  let best: ConfirmedPivot | null = null;
  // Bounded scan from the newest pivot: the reference swing sits just before a sweep that is itself
  // at most `sweepLookbackBars` old, so the answer is always among the most recent pivots.
  const floor = Math.max(0, pivots.length - LATEST_PIVOT_SCAN_DEPTH);
  for (let i = pivots.length - 1; i >= floor; i -= 1) {
    const p = pivots[i];
    if (p.type !== type || p.confirmedAtIndex > knownByIndex || p.index >= beforeIndex) continue;
    if (best === null || p.index > best.index) best = p;
  }
  return best;
}
