import type { DealingRange } from "./bias.js";
import type { TrendDirection } from "./structure.js";

/**
 * "Optimal Trade Entry" (OTE) -- source doctrine lecture 10 (~168:00-179:00, "OTE"/"Ope ट्रेड
 * एंट्री"): a Fibonacci retracement zone, the 62-79% retracement of one clean, bias-aligned swing
 * leg (marked body-to-body, no major internal pullbacks), used as the entry zone once a
 * lower-timeframe rejection/displacement confirms it -- "0.5 के अबव है क्लोज नहीं कर पा रही...
 * देन ये वर्क करेगा" is the same 50%-respect language `zones.ts`'s order-block mean-threshold
 * check already uses, applied here to a swing leg instead of a block.
 *
 * The doctrine's "swing leg" is not a new concept this codebase needs to invent: `bias.ts`'s
 * `DealingRange` (`structure.lastHH`/`lastHL` for a bullish leg, `lastLH`/`lastLL` for a bearish
 * one) already IS that leg, marked the same body-to-body way. OTE reuses it rather than
 * re-deriving a second swing abstraction.
 *
 * The band math (21-38% up from the range low for a bullish/discount entry, mirrored as 62-79% up
 * from the low for a bearish/premium entry -- the same numbers, since a 62-79% retracement measured
 * DOWN from the high is 21-38% of the range measured UP from the low) already exists as a
 * strategy-layer FILTER in `strategy-engine/domain/ict-structure-strategy.ts`'s private
 * `isWithinOte` (entry-model arm 3, `requireOte`). That filter answers only "is the signal bar
 * inside the band" as a boolean gate. This module is the doctrine-faithful FEATURE counterpart --
 * it exists at the covariate level (a distance, not a gate), independent of any strategy's gating
 * decision, following the same "feature, not signal" posture as `distanceToNearestOrderBlock` and
 * `refinedOrderBlock` in `feature-extraction.ts`. The two are intentionally not merged: the strategy
 * filter is a pinned, versioned, already-measured configuration (`defaultIctStructureStrategyConfiguration`)
 * and changing what it imports is out of scope for adding a feature.
 *
 * This is a same-timeframe feature (unlike the refined order block, which needs a HTF snapshot): the
 * dealing range and trend both come from the one `IctStateCompositeSnapshot` a bar already carries.
 */

export interface OteFeature {
  /** Which side the OTE band is drawn for -- the same side `DealingRange` itself was built from. */
  readonly side: "BULLISH" | "BEARISH";
  /** Whether `currentPrice` currently sits inside the 62-79%-retracement OTE band. */
  readonly isWithinOte: boolean;
  /** The band's low edge, in price terms (`bandLow <= bandHigh` always). */
  readonly oteBandLow: number;
  /** The band's high edge, in price terms. */
  readonly oteBandHigh: number;
  /**
   * Unsigned distance from `currentPrice` to the band: 0 when already inside it, otherwise the
   * distance to whichever edge is nearer. Direction is not carried separately here (unlike
   * `distanceToBosLevel`) because "inside vs. how far outside" is the doctrine's own framing --
   * there is no meaningful sign once you are on the correct side of the range for this trend.
   */
  readonly distanceToOteBand: number;
}

/** The retracement band, expressed as a fraction of the range's span up from its low. */
const OTE_LOWER_RATIO = 0.21;
const OTE_UPPER_RATIO = 0.38;

/**
 * Computes the OTE feature for one instant, given the current dealing range and trend.
 *
 * Null when there is no dealing range yet (`bias.dealingRange === null`) -- the same "genuinely
 * absent, not a zero" convention `extractIctStructuralFeatures` already uses elsewhere -- when the
 * trend is `NEUTRAL` (the doctrine's band is drawn FOR a direction; there is no OTE for a range with
 * no side), or when the range is degenerate (`rangeHigh <= rangeLow`, which `bias.ts` already
 * guards against when constructing a `DealingRange` but is re-checked here defensively).
 */
export function computeOte(
  dealingRange: DealingRange | null,
  trend: TrendDirection,
  currentPrice: number
): OteFeature | null {
  if (dealingRange === null || trend === "NEUTRAL") return null;

  const span = dealingRange.rangeHigh - dealingRange.rangeLow;
  if (!(span > 0)) return null;

  const isBullish = trend === "BULLISH";
  const oteBandLow = isBullish
    ? dealingRange.rangeLow + span * OTE_LOWER_RATIO
    : dealingRange.rangeLow + span * (1 - OTE_UPPER_RATIO);
  const oteBandHigh = isBullish
    ? dealingRange.rangeLow + span * OTE_UPPER_RATIO
    : dealingRange.rangeLow + span * (1 - OTE_LOWER_RATIO);

  const isWithinOte = currentPrice >= oteBandLow && currentPrice <= oteBandHigh;
  const distanceToOteBand = isWithinOte
    ? 0
    : Math.min(Math.abs(currentPrice - oteBandLow), Math.abs(currentPrice - oteBandHigh));

  return {
    side: isBullish ? "BULLISH" : "BEARISH",
    isWithinOte,
    oteBandLow,
    oteBandHigh,
    distanceToOteBand,
  };
}
