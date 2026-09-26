import type { FairValueGap } from "./zones.js";

/**
 * BPR -- Balanced Price Range.
 *
 * Researched against source material before implementation. Search-synthesised across multiple
 * retail sources (LuxAlgo, GrandAlgo, ictflow.com, innercircletrader.net, tradingfinder.com), which
 * agree on the mechanism without the first-vs-last-candle ambiguity that complicated cisd.ts:
 *
 * "A balanced price range is the overlap of two opposing fair value gaps... a bullish FVG (formed on
 * a buy-side displacement leg) and a bearish FVG (formed on a sell-side displacement leg) intersect
 * at a single price band... When a bullish fair value gap forms first and a bearish gap then cuts
 * back through the same area, the overlap is a bearish BPR and gets watched as resistance; the
 * mirror sequence gives a bullish one."
 *
 * So the label is decided by WHICH GAP IS MORE RECENT, not by either gap's own type in isolation --
 * the second, more recent displacement is what most recently "delivered" through that band, and that
 * is the direction the zone is traded in going forward.
 *
 * ## Deliberately a pure computation, not a stateful ledger
 *
 * Unlike `zones.ts`'s own FVG/OB tracking, a BPR needs no lifecycle bookkeeping of its own: it is
 * fully defined by its two constituent gaps, which `zones.ts` already tracks (creation, fill,
 * invalidation, inversion). Recomputing it fresh from `activeFvgs` on every bar means its existence
 * and boundaries are automatically correct without a second copy of fill/invalidation logic to keep
 * in sync with the first -- the moment either constituent gap leaves `activeFvgs` (filled, invalidated,
 * inverted), the BPR built from it silently and correctly stops being reported, for free.
 *
 * ## No minimum time-proximity requirement
 *
 * Sources describe the second gap forming "shortly after" the first, but none states a bound, and
 * this codebase's own convention (see `orderBlockLookbackBars`, `maxCisdAgeBars`) is to not invent an
 * unmeasured threshold where the source material gives none. Two currently-active, opposing-type,
 * genuinely overlapping gaps are a BPR regardless of how far apart their creation bars are; if a
 * proximity requirement turns out to matter, that is a configuration to measure, not a default to
 * assume.
 */

export interface BalancedPriceRange {
  readonly id: string;
  /** The more recently formed gap's direction -- see the file docstring for why. */
  readonly type: "BULLISH" | "BEARISH";
  readonly top: number;
  readonly bottom: number;
  /** Midpoint of the OVERLAP band, not of either constituent gap -- this zone's own consequent encroachment. */
  readonly meanThreshold: number;
  readonly olderGapId: string;
  readonly newerGapId: string;
  /** The newer gap's own creation bar -- when this specific overlap came into existence. */
  readonly formedAtBarIndex: number;
}

/**
 * Every currently-active opposing-type gap pair whose ranges genuinely overlap (strict, not merely
 * touching at one price). Pure function of the currently active gap list; call fresh every bar.
 */
export function computeBalancedPriceRanges(activeFvgs: readonly FairValueGap[]): readonly BalancedPriceRange[] {
  const bullish = activeFvgs.filter((f) => f.type === "BULLISH");
  const bearish = activeFvgs.filter((f) => f.type === "BEARISH");
  const results: BalancedPriceRange[] = [];

  for (const b of bullish) {
    for (const r of bearish) {
      const top = Math.min(b.top, r.top);
      const bottom = Math.max(b.bottom, r.bottom);
      if (top <= bottom) continue; // no genuine overlap, or only a single-price touch

      const newer = b.createdAtBarIndex >= r.createdAtBarIndex ? b : r;
      const older = newer === b ? r : b;

      results.push({
        id: `bpr-${older.id}-${newer.id}`,
        type: newer.type,
        top,
        bottom,
        meanThreshold: (top + bottom) / 2,
        olderGapId: older.id,
        newerGapId: newer.id,
        formedAtBarIndex: newer.createdAtBarIndex,
      });
    }
  }

  return results;
}
