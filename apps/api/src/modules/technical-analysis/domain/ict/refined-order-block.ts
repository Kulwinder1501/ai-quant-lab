import { isDoctrinallyValidOrderBlockCandidate, type OrderBlock } from "./zones.js";
import type { IctStateCompositeSnapshot } from "./config.js";

/**
 * The "Refined Order Block" construction from lecture 4 (Order Block/FVG), and the structure-mapping
 * anchoring rule from lecture 3 (BOS/CHoCH) -- both checked directly against the source transcripts,
 * not inferred.
 *
 * The doctrine's order blocks and structure are NOT detected independently per timeframe. Lecture 4
 * walks through this explicitly: a 4H order block with a 200-point range is "too big a stop-loss", so
 * it is marked as a box, then the trader drops to 15m and searches ONLY inside that box for a smaller
 * order block (found: 75 points), then drops to 5m inside THAT box for a smaller one still (25
 * points). A second example: a 30m order block (~90-94 pts) is refined on 5m by finding "the one with
 * an FVG on top -- nowhere else has an FVG", again only searched for inside the 30m box. Lecture 3's
 * structure-mapping section is explicit that starting cold on a low timeframe produces nothing valid
 * ("आप कहीं से भी स्टार्ट कर दोगे... देन कुछ नहीं होने वाला") -- you must first mark the anchor on a
 * higher timeframe, then continue mapping on the lower timeframe from that point.
 *
 * So "distance to nearest order block" computed independently on one timeframe (this module's
 * sibling, `feature-extraction.ts`'s `distanceToNearestOrderBlock`) is not the doctrine's construction
 * at all -- it is the naive, single-timeframe approximation this module replaces with the real one:
 * find the relevant HTF order block, then require the LTF order block to be NESTED inside it.
 *
 * This is still features, not signal (see ict-as-feature-source-no-benefit memory) -- a pure
 * cross-timeframe read, not a trading decision.
 */

export interface RefinedOrderBlockFeature {
  /** The higher-timeframe order block the refinement is anchored to. */
  readonly htfOrderBlockSide: "BULLISH" | "BEARISH";
  /** Unsigned distance from current price to the HTF order block's own mean threshold ("the big stop"). */
  readonly htfOrderBlockDistance: number;
  /**
   * Unsigned distance to the nested, lower-timeframe order block's mean threshold ("the tightened
   * stop"), or null when no LTF order block currently active is nested inside the HTF one -- the
   * doctrine's own refinement is genuinely absent on this bar, not a zero.
   */
  readonly refinedOrderBlockDistance: number | null;
  /**
   * (refined range) / (HTF range), in (0, 1] when a refinement exists -- how much the doctrine's
   * "refine to shrink the stop-loss" move actually shrank it. Null alongside a null refinement.
   */
  readonly stopCompressionRatio: number | null;
}

function range(ob: OrderBlock): number {
  return ob.top - ob.bottom;
}

function distanceToMeanThreshold(ob: OrderBlock, price: number): number {
  return Math.abs(price - ob.meanThreshold);
}

/**
 * The HTF order block a trader would currently be watching: the nearest-to-price one among the
 * doctrinally valid candidates (`isDoctrinallyValidOrderBlockCandidate` -- only the IDM-adjacent or
 * extreme block in the current swing range is ever a real candidate, on any timeframe; see its own
 * docstring in zones.ts). The doctrine assumes the trader has already picked one from their own
 * directional read; nearest-to-price among the valid set is the simplest stand-in for that judgment
 * call, since a feature extractor has no directional read of its own to consult.
 */
function selectRelevantHtfOrderBlock(htfObs: readonly OrderBlock[], price: number): OrderBlock | null {
  let best: OrderBlock | null = null;
  let bestDistance = Infinity;
  for (const ob of htfObs) {
    if (!isDoctrinallyValidOrderBlockCandidate(ob)) continue;
    const distance = distanceToMeanThreshold(ob, price);
    if (distance < bestDistance) {
      best = ob;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Every LTF order block whose full range lies within the HTF order block's range, same polarity, and
 * strictly smaller (a real refinement, not an equal or wider "nesting" that shrinks nothing).
 */
function nestedCandidates(htfOb: OrderBlock, ltfObs: readonly OrderBlock[]): OrderBlock[] {
  const htfRange = range(htfOb);
  return ltfObs.filter(
    (ltfOb) =>
      ltfOb.type === htfOb.type &&
      ltfOb.top <= htfOb.top &&
      ltfOb.bottom >= htfOb.bottom &&
      range(ltfOb) < htfRange
  );
}

/**
 * Picks the refinement among nested candidates, per lecture 4's own stated preference: the one WITH
 * an attached FVG ("जिसके ऊपर एफजी है बाकी कहीं पर भी एफजी नहीं है"), then the tightest (smallest
 * range -- the entire point of refining), then the most recently formed.
 */
function selectRefinement(candidates: readonly OrderBlock[]): OrderBlock | null {
  if (candidates.length === 0) return null;
  const withFvg = candidates.filter((ob) => ob.attachedFvgId !== null);
  const pool = withFvg.length > 0 ? withFvg : candidates;
  return [...pool].sort((a, b) => range(a) - range(b) || b.createdAtBarIndex - a.createdAtBarIndex)[0];
}

/**
 * Computes the refined-order-block feature for one instant, given the HTF order blocks visible at
 * that instant (already anti-lookahead aligned by the caller -- see `alignHtfSnapshotsToLtf`) and the
 * LTF order blocks active on the same bar.
 *
 * Null when no HTF order block is currently active -- there is nothing to anchor a refinement to.
 */
export function computeRefinedOrderBlock(
  htfObs: readonly OrderBlock[],
  ltfObs: readonly OrderBlock[],
  currentPrice: number
): RefinedOrderBlockFeature | null {
  const htfOb = selectRelevantHtfOrderBlock(htfObs, currentPrice);
  if (htfOb === null) return null;

  const refined = selectRefinement(nestedCandidates(htfOb, ltfObs));
  const htfRange = range(htfOb);
  return {
    htfOrderBlockSide: htfOb.type,
    htfOrderBlockDistance: distanceToMeanThreshold(htfOb, currentPrice),
    refinedOrderBlockDistance: refined === null ? null : distanceToMeanThreshold(refined, currentPrice),
    stopCompressionRatio: refined === null ? null : range(refined) / htfRange,
  };
}

export interface HtfSnapshotWithCloseTime {
  /**
   * The HTF bar's own CLOSE time, not `snapshot.barTime` (which is the bar's OPEN time -- see
   * `composite-engine.ts`). A bar is not safely visible until it closes; keying anti-lookahead off
   * the open time would let a still-forming HTF bar's order blocks leak into an LTF bar inside it.
   */
  readonly closeTime: Date;
  readonly snapshot: IctStateCompositeSnapshot;
}

/**
 * Aligns a chronological series of HTF composite snapshots onto an LTF bar timeline, anti-lookahead:
 * the HTF snapshot visible to an LTF bar is the latest one whose CLOSE time is at or before that LTF
 * bar's own close time. Mirrors `deriveHtfBiasSeries`'s two-pointer walk over `bucket.closeTime`
 * (both series are chronological, so the latest visible HTF bar only ever moves forward), generalised
 * to hand back the whole snapshot rather than just a bias direction, since this needs the HTF
 * snapshot's `zones.activeObs`.
 *
 * `htfBars` and `ltfCloseTimes` must each already be in chronological order.
 */
export function alignHtfSnapshotsToLtf(
  htfBars: readonly HtfSnapshotWithCloseTime[],
  ltfCloseTimes: readonly Date[]
): (IctStateCompositeSnapshot | null)[] {
  const aligned: (IctStateCompositeSnapshot | null)[] = new Array(ltfCloseTimes.length).fill(null);
  let htfIndex = 0;
  let latest: IctStateCompositeSnapshot | null = null;
  for (let i = 0; i < ltfCloseTimes.length; i += 1) {
    const closeMs = ltfCloseTimes[i].getTime();
    while (htfIndex < htfBars.length && htfBars[htfIndex].closeTime.getTime() <= closeMs) {
      latest = htfBars[htfIndex].snapshot;
      htfIndex += 1;
    }
    aligned[i] = latest;
  }
  return aligned;
}
