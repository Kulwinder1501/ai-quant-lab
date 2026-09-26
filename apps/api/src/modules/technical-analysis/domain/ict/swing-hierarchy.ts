import type { ConfirmedPivot } from "./causal-pivot.js";
import type { TrendDirection } from "./structure.js";

/**
 * ITH/ITL/STH/STL swing hierarchy -- source doctrine lecture 8 ("WHAT Is ITH ITL STH STL"), read in
 * full (not grep-sampled) as part of the 2026-09-15 verification pass documented in
 * `ict-implementation-vs-source-doctrine` memory.
 *
 * The doctrine's atomic unit is a "Three-Candle-Swing" (left candle, mid candle -- the extreme,
 * right candle). That is the same CATEGORY of primitive this codebase already computes as a
 * `ConfirmedPivot` (`causal-pivot.ts`'s `findConfirmedPivotAt`, a strictly-causal fractal swing
 * point) -- just parameterised differently (this engine's `pivotLength` defaults to 3 bars each
 * side, the doctrine's literal example is 1). This module reuses that existing primitive rather
 * than building a second, competing swing detector, the same "extract the behaviour, not the literal
 * parameterisation" discipline `ote.ts` already applied to the doctrine's swing leg.
 *
 * **ITH/ITL (Intermediate Term High/Low)**: doctrine's own rule is that a genuine ITH/ITL forms only
 * when THREE consecutive Three-Candle-Swings of the same type nest correctly -- left lower, middle
 * highest, right lower (mirrored for a low: left higher, middle lowest, right higher). That is
 * exactly the classic "swing of swings": among three consecutive same-type `ConfirmedPivot`s, the
 * middle one is an ITH/ITL iff it is more extreme than both of its same-type neighbours. It can only
 * be confirmed once the third (right) same-type pivot exists -- one hop of lag beyond the underlying
 * `ConfirmedPivot` itself, and strictly causal for the same reason `findConfirmedPivotAt` is: nothing
 * here looks at a pivot before its own right-wing has closed.
 *
 * **STH/STL (Short Term High/Low)**: every same-type pivot that is NOT elevated to ITH/ITL by that
 * rule. The doctrine frames these as temporary structure forming between confirmed Intermediate Term
 * points ("टेंपररी शॉर्ट टर्म हाई एंड शॉर्ट टर्म लो बीच में बनते जाएंगे") -- not a detection rule of
 * their own; a pivot is short-term by DEFAULT until three-in-a-row promotes it.
 *
 * **The directional "which side breaks" rule**: if the trend is bullish, the doctrine's protected
 * level is the most recent ITL -- it should not break until the higher-timeframe bias itself
 * reverses -- while the ITH is the level expected to keep breaking (repeated BOS) on the way to that
 * target; mirrored for a bearish trend (ITH protected, ITL expected to break). An STH/STL inherits
 * the same protection as its enclosing ITL/ITH, so this module does not classify their protection
 * separately -- the ITH/ITL protected-side check already covers both. This surfaces as a single
 * same-bar check (has price already closed beyond the protected level) rather than tracked
 * invalidation state over time -- the same "compute fresh each bar from what is confirmed right now"
 * convention `structure.ts`'s own `bosLevel`/`chochLevel` already use (see that file's docstring): a
 * non-null protected level here means "this is what the hierarchy currently names as protected", not
 * a promise it survives untouched into the next bar.
 */

export type SwingTier = "INTERMEDIATE_TERM" | "SHORT_TERM";

export interface ClassifiedSwing {
  readonly pivot: ConfirmedPivot;
  readonly tier: SwingTier;
}

/**
 * The four categories the doctrine names, as of one instant: the most recent confirmed pivot in each
 * -- not the whole classified history. Computed fresh from the SAME confirmed-pivot stream
 * `IctStructureTracker` already accumulates (`confirmedPivotsView()`) and, per that method's own
 * "use it and drop it, never store it" rule, this snapshot is the bounded, small thing that survives
 * the bar -- the raw pivot list itself never does.
 */
export interface SwingHierarchySnapshot {
  readonly nearestIntermediateTermHigh: ConfirmedPivot | null;
  readonly nearestIntermediateTermLow: ConfirmedPivot | null;
  readonly nearestShortTermHigh: ConfirmedPivot | null;
  readonly nearestShortTermLow: ConfirmedPivot | null;
}

/** True when `middle` is strictly more extreme than BOTH of its same-type neighbours. */
function isLocalExtremum(left: ConfirmedPivot, middle: ConfirmedPivot, right: ConfirmedPivot): boolean {
  if (middle.type === "HIGH") return middle.price > left.price && middle.price > right.price;
  return middle.price < left.price && middle.price < right.price;
}

/**
 * Classifies every confirmed pivot into INTERMEDIATE_TERM or SHORT_TERM, per same-type triple.
 *
 * The first and last pivot of each type can never be classified INTERMEDIATE_TERM (no left or no
 * right same-type neighbour exists yet in the supplied history) and default to SHORT_TERM --
 * "unclassified so far", not "confirmed to never become an ITH/ITL": a later same-type pivot can
 * retroactively promote today's last one as soon as its own right neighbour arrives.
 */
export function classifySwingHierarchy(pivots: readonly ConfirmedPivot[]): readonly ClassifiedSwing[] {
  const byType: { HIGH: ConfirmedPivot[]; LOW: ConfirmedPivot[] } = { HIGH: [], LOW: [] };
  for (const pivot of pivots) byType[pivot.type].push(pivot);

  const tierByPivot = new Map<ConfirmedPivot, SwingTier>();
  for (const series of [byType.HIGH, byType.LOW]) {
    for (let i = 0; i < series.length; i += 1) {
      const isIntermediate =
        i > 0 && i < series.length - 1 && isLocalExtremum(series[i - 1], series[i], series[i + 1]);
      tierByPivot.set(series[i], isIntermediate ? "INTERMEDIATE_TERM" : "SHORT_TERM");
    }
  }

  return pivots.map((pivot) => ({ pivot, tier: tierByPivot.get(pivot) ?? "SHORT_TERM" }));
}

/** Reduces the full classification down to "the most recent pivot in each of the four categories". */
export function computeSwingHierarchySnapshot(pivots: readonly ConfirmedPivot[]): SwingHierarchySnapshot {
  let nearestIntermediateTermHigh: ConfirmedPivot | null = null;
  let nearestIntermediateTermLow: ConfirmedPivot | null = null;
  let nearestShortTermHigh: ConfirmedPivot | null = null;
  let nearestShortTermLow: ConfirmedPivot | null = null;

  for (const { pivot, tier } of classifySwingHierarchy(pivots)) {
    if (tier === "INTERMEDIATE_TERM") {
      if (pivot.type === "HIGH") nearestIntermediateTermHigh = pivot;
      else nearestIntermediateTermLow = pivot;
    } else {
      if (pivot.type === "HIGH") nearestShortTermHigh = pivot;
      else nearestShortTermLow = pivot;
    }
  }

  return { nearestIntermediateTermHigh, nearestIntermediateTermLow, nearestShortTermHigh, nearestShortTermLow };
}

export type ProtectedSide = "INTERMEDIATE_TERM_HIGH" | "INTERMEDIATE_TERM_LOW";

export interface SwingHierarchyFeature {
  readonly distanceToIntermediateTermHigh: number | null;
  readonly distanceToIntermediateTermLow: number | null;
  readonly distanceToShortTermHigh: number | null;
  readonly distanceToShortTermLow: number | null;
  /**
   * Which side the doctrine currently calls protected, given the trend -- null when the trend is
   * NEUTRAL or the relevant Intermediate Term point has not formed yet, the same "genuinely absent,
   * not a zero" convention every other optional field in this codebase's ICT features already uses.
   */
  readonly protectedSide: ProtectedSide | null;
  /**
   * Whether `currentPrice` already sits beyond the protected level -- the doctrine's own framing of
   * this hierarchy as an early warning that a bias read may be wrong (lecture 11's bias section:
   * "ऐसे कौन से पॉइंट हैं जो हमें बताएं कि यार तू गलत कर रहा है"). False whenever `protectedSide` is
   * null -- nothing to have breached.
   */
  readonly protectedLevelBreached: boolean;
}

function distanceTo(pivot: ConfirmedPivot | null, currentPrice: number): number | null {
  return pivot === null ? null : Math.abs(currentPrice - pivot.price);
}

/**
 * Computes the swing-hierarchy feature for one instant, given the current snapshot, trend, and price.
 */
export function computeSwingHierarchyFeature(
  snapshot: SwingHierarchySnapshot,
  trend: TrendDirection,
  currentPrice: number
): SwingHierarchyFeature {
  let protectedSide: ProtectedSide | null = null;
  let protectedLevelBreached = false;

  if (trend === "BULLISH" && snapshot.nearestIntermediateTermLow !== null) {
    protectedSide = "INTERMEDIATE_TERM_LOW";
    protectedLevelBreached = currentPrice < snapshot.nearestIntermediateTermLow.price;
  } else if (trend === "BEARISH" && snapshot.nearestIntermediateTermHigh !== null) {
    protectedSide = "INTERMEDIATE_TERM_HIGH";
    protectedLevelBreached = currentPrice > snapshot.nearestIntermediateTermHigh.price;
  }

  return {
    distanceToIntermediateTermHigh: distanceTo(snapshot.nearestIntermediateTermHigh, currentPrice),
    distanceToIntermediateTermLow: distanceTo(snapshot.nearestIntermediateTermLow, currentPrice),
    distanceToShortTermHigh: distanceTo(snapshot.nearestShortTermHigh, currentPrice),
    distanceToShortTermLow: distanceTo(snapshot.nearestShortTermLow, currentPrice),
    protectedSide,
    protectedLevelBreached,
  };
}
