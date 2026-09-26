import type { IctStateCompositeSnapshot } from "./config.js";
import type { IctBiasDirection } from "./bias.js";
import { isDoctrinallyValidOrderBlockCandidate, type OrderBlock } from "./zones.js";
import { computeRefinedOrderBlock, type RefinedOrderBlockFeature } from "./refined-order-block.js";
import { computeOte, type OteFeature } from "./ote.js";
import { computeSwingHierarchyFeature, type SwingHierarchyFeature } from "./swing-hierarchy.js";

/**
 * Structural feature extraction for ML consumption -- NOT a trading decision.
 *
 * This is the "features, not signal" reframing of the ICT engine
 * (`ict-implementation-vs-source-doctrine.md` / the four-pillar strategy's own §6 "Marginal"
 * section): the engine's structural read (HTF bias, premium/discount, order-block proximity,
 * unmitigated BOS/CHoCH) as plain covariates for a model to weigh, rather than as gated
 * approve/reject stages. It reuses the same engine and snapshot everything else here does and adds
 * no new state of its own -- given a single `IctStateCompositeSnapshot`, this is a pure function.
 *
 * Point-in-time safety rides entirely on the snapshot it is handed: as of the zone-object
 * immutability fix in `zones.ts`, a snapshot returned for bar N never changes after later bars are
 * processed, so a feature computed from `snapshots[N]` days after a batch replay finished is
 * identical to one computed live at bar N. This module adds nothing that could reintroduce a leak --
 * it reads fields off one already-sealed snapshot and does no lookahead of its own.
 *
 * What this deliberately is NOT: a distance-to-nearest-order-block feature existed nowhere in this
 * codebase before this file (`liquidity.ts` only exposes it folded into a single trade objective, and
 * only when the four-pillar gate is already aligned). This computes it directly off
 * `zones.activeObs`, independent of any gate, so it is available on every bar that has at least one
 * active order block -- which is most bars, unlike the gated `primaryTarget`.
 *
 * `distanceToNearestOrderBlock`/`nearestOrderBlockSide` are checked against the source doctrine and
 * found NAIVE in two distinct ways, corrected in two separate passes:
 *  1. Cross-timeframe: lecture 4 ("Refined Order Block") and lecture 3's structure-mapping section
 *     are both explicit that order blocks and structure are read top-down across timeframes -- a
 *     higher-timeframe order block marks the box, and only a lower-timeframe order block NESTED
 *     inside that same box is the doctrine's actual construction (see `refined-order-block.ts` for
 *     the transcript passages this is checked against).
 *  2. Same-timeframe selection: even on ONE timeframe, the doctrine does not treat every active order
 *     block as a valid candidate -- only the one right after IDM and the one at the extreme end of
 *     the current swing range are real; everything else is explicitly "not a candidate at all" (see
 *     `isDoctrinallyValidOrderBlockCandidate` in zones.ts). This field is filtered to that set.
 * Kept here as the same-timeframe baseline for comparing against the doctrine-faithful
 * `refinedOrderBlock` field below -- corrected on selection, but still same-timeframe, not because
 * ignoring the HTF pairing is itself correct.
 */

export type PremiumDiscountZone = "PREMIUM" | "DISCOUNT" | "UNKNOWN";

export interface IctStructuralFeatures {
  /** Direction of the higher-timeframe (fractal) bias, or null when none was supplied. */
  readonly htfBias: IctBiasDirection | null;
  /**
   * Where the current bar's close sits in the LOCAL dealing range. `UNKNOWN` when no dealing range
   * has formed yet (`bias.dealingRange === null`) -- not a third zone, an absence of the other two.
   */
  readonly premiumDiscountZone: PremiumDiscountZone;
  /**
   * Absolute price distance from the current close to the nearest doctrinally-valid order block's
   * mean threshold (the 50% level the doctrine treats as the actual entry, not the block's outer
   * edge) -- restricted to `isIdmAdjacent`/`isExtreme` blocks, per lecture 4's explicit "whatever
   * forms in between is not a candidate at all" rule (see
   * `isDoctrinallyValidOrderBlockCandidate` in zones.ts). Null when no such order block is currently
   * active. Unsigned by design -- direction is carried separately by `nearestOrderBlockSide`, so a
   * model can learn the two independently rather than this feature silently encoding a sign
   * convention.
   */
  readonly distanceToNearestOrderBlock: number | null;
  /** Polarity of the nearest order block, or null alongside a null distance. */
  readonly nearestOrderBlockSide: "BULLISH" | "BEARISH" | null;
  /**
   * Whether the structure tracker currently carries a BOS/CHoCH level in the trend direction.
   * `structure.bosLevel`/`chochLevel` are recomputed fresh every bar from the current trend and its
   * most recent confirmed swings (see `structure.ts`), so a non-null value here means "a
   * confirmed swing exists to derive this level from right now", not "this specific level was set N
   * bars ago and never touched since" -- there is no independent per-level invalidation tracked.
   * Treat these as "structure is currently coherent enough to name a level", not as a promise the
   * level survives untouched into the next bar.
   */
  readonly hasBosLevel: boolean;
  readonly hasChochLevel: boolean;
  /** Signed distance (current close minus level) so direction is preserved; null when absent. */
  readonly distanceToBosLevel: number | null;
  readonly distanceToChochLevel: number | null;
  /**
   * The doctrine-faithful, cross-timeframe order-block refinement (see `refined-order-block.ts`).
   * Null when no `htfSnapshot` was supplied to `extractIctStructuralFeatures`, or when one was
   * supplied but no HTF order block is currently active -- there is nothing to anchor a refinement
   * to on this bar either way.
   */
  readonly refinedOrderBlock: RefinedOrderBlockFeature | null;
  /**
   * The doctrine-faithful "Optimal Trade Entry" -- the 62-79% retracement band of the current
   * dealing range (see `ote.ts`). Null under the same "genuinely absent, not a zero" convention as
   * every other optional field here: no dealing range has formed yet, or the trend is `NEUTRAL` (the
   * band only exists for a side).
   */
  readonly ote: OteFeature | null;
  /**
   * The ITH/ITL/STH/STL swing hierarchy (see `swing-hierarchy.ts`) -- always present as a record,
   * unlike `ote`/`refinedOrderBlock`, because its own fields (not this wrapper) carry the "genuinely
   * absent" nulls for whichever Intermediate/Short Term point has not formed yet.
   */
  readonly swingHierarchy: SwingHierarchyFeature;
}

function nearestOrderBlock(
  obs: readonly OrderBlock[],
  currentPrice: number
): { readonly ob: OrderBlock; readonly distance: number } | null {
  let best: { ob: OrderBlock; distance: number } | null = null;
  for (const ob of obs) {
    const distance = Math.abs(currentPrice - ob.meanThreshold);
    if (best === null || distance < best.distance) {
      best = { ob, distance };
    }
  }
  return best;
}

export function extractIctStructuralFeatures(
  snapshot: IctStateCompositeSnapshot,
  currentPrice: number,
  /**
   * The higher-timeframe composite snapshot visible as of this bar (already anti-lookahead aligned
   * by the caller -- see `alignHtfSnapshotsToLtf`), or omitted/null when no HTF series is available.
   * Optional so every existing single-timeframe caller is unaffected.
   */
  htfSnapshot?: IctStateCompositeSnapshot | null
): IctStructuralFeatures {
  const dealingRange = snapshot.bias.dealingRange;
  const premiumDiscountZone: PremiumDiscountZone =
    dealingRange === null ? "UNKNOWN" : dealingRange.isPremium(currentPrice) ? "PREMIUM" : "DISCOUNT";

  const nearest = nearestOrderBlock(
    snapshot.zones.activeObs.filter(isDoctrinallyValidOrderBlockCandidate),
    currentPrice
  );

  const bosLevel = snapshot.structure.bosLevel;
  const chochLevel = snapshot.structure.chochLevel;

  return {
    htfBias: snapshot.htfBias,
    premiumDiscountZone,
    distanceToNearestOrderBlock: nearest?.distance ?? null,
    nearestOrderBlockSide: nearest?.ob.type ?? null,
    hasBosLevel: bosLevel !== null,
    hasChochLevel: chochLevel !== null,
    distanceToBosLevel: bosLevel !== null ? currentPrice - bosLevel : null,
    distanceToChochLevel: chochLevel !== null ? currentPrice - chochLevel : null,
    refinedOrderBlock:
      htfSnapshot == null
        ? null
        : computeRefinedOrderBlock(htfSnapshot.zones.activeObs, snapshot.zones.activeObs, currentPrice),
    ote: computeOte(dealingRange, snapshot.structure.trend, currentPrice),
    swingHierarchy: computeSwingHierarchyFeature(snapshot.swingHierarchy, snapshot.structure.trend, currentPrice),
  };
}
