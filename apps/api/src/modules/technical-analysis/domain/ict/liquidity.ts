import type { ConfirmedPivot } from "./causal-pivot.js";
import type { IctStructureSnapshot } from "./structure.js";
import type { IctZoneSnapshot, FairValueGap, OrderBlock } from "./zones.js";
import type { SessionLevelsSnapshot } from "./session-levels.js";
import type { IctBiasSnapshot } from "./bias.js";

export type LiquidityPoolKind =
  | "ERL_PDH"
  | "ERL_PDL"
  | "ERL_SWING_HIGH"
  | "ERL_SWING_LOW"
  | "ERL_EQH"
  | "ERL_EQL"
  | "IRL_FVG"
  | "IRL_OB";

export interface LiquidityPool {
  readonly id: string;
  readonly kind: LiquidityPoolKind;
  readonly price: number;
  readonly top?: number;
  readonly bottom?: number;
  readonly isMitigated: boolean;
}

export type FourPillarAlignmentStatus =
  | "ALIGNED_LONG"
  | "ALIGNED_SHORT"
  | "BLOCKED_PREMIUM_LONG"
  | "BLOCKED_DISCOUNT_SHORT"
  | "BLOCKED_BIAS_STRUCTURE_DISAGREEMENT"
  | "BLOCKED_MISSING_PILLAR";

export interface IctLiquiditySnapshot {
  /*
   * Counts, not the lists.
   *
   * The full pool arrays were carried in every snapshot and read by NOTHING outside this file --
   * write-only, yet JSON-serialised into `ict_state_snapshots` on every persisted row. Pools
   * accumulate with confirmed pivots, so the list grew linearly with bars while the number of
   * snapshots grew too: retained memory was quadratic, measured at 54KB per snapshot by bar 5,000,
   * which OOM'd a 10,405-bar run at a 4GB heap.
   *
   * Everything downstream reads only the DERIVED fields below -- the selected objective, the
   * waypoint, the invalidation level and the status. Counts are kept for observability.
   */
  readonly erlPoolCount: number;
  readonly irlPoolCount: number;
  readonly primaryTarget: LiquidityPool | null;
  readonly intermediateTarget: number | null;
  readonly invalidationLevel: number | null;
  readonly alignmentStatus: FourPillarAlignmentStatus;
  readonly rationale: string;
}

export class IctLiquidityResolver {
  resolve(
    currentPrice: number,
    biasSnap: IctBiasSnapshot,
    structSnap: IctStructureSnapshot,
    zoneSnap: IctZoneSnapshot,
    sessionLevels: SessionLevelsSnapshot,
    /** Passed in rather than read off the snapshot, which no longer carries the history. */
    confirmedPivots: readonly ConfirmedPivot[] = []
  ): IctLiquiditySnapshot {
    const erlPools: LiquidityPool[] = [];
    const irlPools: LiquidityPool[] = [];

    // 1. Collect External Range Liquidity (ERL)
    if (sessionLevels.levels) {
      erlPools.push({
        id: "erl-pdh",
        kind: "ERL_PDH",
        price: sessionLevels.levels.pdh,
        isMitigated: sessionLevels.currentSessionHigh >= sessionLevels.levels.pdh,
      });
      erlPools.push({
        id: "erl-pdl",
        kind: "ERL_PDL",
        price: sessionLevels.levels.pdl,
        isMitigated: sessionLevels.currentSessionLow <= sessionLevels.levels.pdl,
      });
    }

    if (structSnap.lastHH) {
      erlPools.push({
        id: `erl-hh-${structSnap.lastHH.index}`,
        kind: "ERL_SWING_HIGH",
        price: structSnap.lastHH.price,
        isMitigated: currentPrice >= structSnap.lastHH.price,
      });
    }
    if (structSnap.lastHL) {
      erlPools.push({
        id: `erl-hl-${structSnap.lastHL.index}`,
        kind: "ERL_SWING_LOW",
        price: structSnap.lastHL.price,
        isMitigated: currentPrice <= structSnap.lastHL.price,
      });
    }
    if (structSnap.lastLH) {
      erlPools.push({
        id: `erl-lh-${structSnap.lastLH.index}`,
        kind: "ERL_SWING_HIGH",
        price: structSnap.lastLH.price,
        isMitigated: currentPrice >= structSnap.lastLH.price,
      });
    }
    if (structSnap.lastLL) {
      erlPools.push({
        id: `erl-ll-${structSnap.lastLL.index}`,
        kind: "ERL_SWING_LOW",
        price: structSnap.lastLL.price,
        isMitigated: currentPrice <= structSnap.lastLL.price,
      });
    }

    // Detect Equal Highs (EQH) and Equal Lows (EQL)
    const highs = confirmedPivots.filter((p) => p.type === "HIGH");
    const lows = confirmedPivots.filter((p) => p.type === "LOW");
    /*
     * Equal Highs / Equal Lows, grouped rather than paired.
     *
     * This was an all-pairs double loop over every confirmed pivot, run on EVERY bar. Pivots grow
     * linearly with bars, so the scan was quadratic per bar and cubic over a run -- and it pushed one
     * pool per matching PAIR, so five equal highs became ten pools at essentially one price. Every
     * snapshot then embedded that quadratically-growing array. A single 10,405-bar run died at a 10GB
     * heap, which is why the 20-month measurements had to be chunked.
     *
     * Sorting and grouping adjacent levels within tolerance is O(k log k) and emits ONE pool per
     * price level. The set of price LEVELS is identical, which is what matters: objective selection
     * picks by price (the farthest unmitigated pool beyond equilibrium), never by pool count or id.
     *
     * Trimming old pivots was tried first and rejected: it changed the results, because after the
     * farthest-ERL objective fix the target is frequently an OLD distant pool, so dropping pivots
     * deletes the very levels the strategy aims at. Retention and the objective are coupled; cost
     * and retention are not.
     */
    // 5 bps, exactly the threshold the all-pairs scan hardcoded, so grouping cannot change which
    // levels qualify. `IctEngineConfig.equalHighLowTolerancePct` holds the same 0.05% but this
    // resolver is stateless and never received the config; unifying them is a separate change.
    const toleranceBps = 5;

    const groupEqualLevels = (
      pivots: readonly ConfirmedPivot[],
      kind: "ERL_EQH" | "ERL_EQL",
    ): void => {
      if (pivots.length < 2) return;
      const sorted = [...pivots].sort((a, b) => a.price - b.price);
      let groupStart = 0;
      const flush = (from: number, to: number): void => {
        if (to - from < 1) return; // a lone pivot is not an EQH/EQL cluster
        const members = sorted.slice(from, to + 1);
        const price = kind === "ERL_EQH"
          ? Math.max(...members.map((m) => m.price))
          : Math.min(...members.map((m) => m.price));
        const indices = members.map((m) => m.index).sort((a, b) => a - b);
        erlPools.push({
          id: `erl-${kind === "ERL_EQH" ? "eqh" : "eql"}-${indices[0]}-${indices[indices.length - 1]}`,
          kind,
          price,
          isMitigated: kind === "ERL_EQH" ? currentPrice >= price : currentPrice <= price,
        });
      };
      for (let i = 1; i < sorted.length; i += 1) {
        const spanBps = (Math.abs(sorted[i].price - sorted[groupStart].price) / sorted[groupStart].price) * 10000;
        if (spanBps > toleranceBps) {
          flush(groupStart, i - 1);
          groupStart = i;
        }
      }
      flush(groupStart, sorted.length - 1);
    };

    groupEqualLevels(highs, "ERL_EQH");
    groupEqualLevels(lows, "ERL_EQL");

    // 2. Collect Internal Range Liquidity (IRL)
    for (const fvg of zoneSnap.activeFvgs) {
      irlPools.push({
        id: fvg.id,
        kind: "IRL_FVG",
        price: fvg.midpoint,
        top: fvg.top,
        bottom: fvg.bottom,
        isMitigated: fvg.state === "CONSUMED" || fvg.fillPercentage >= 0.5,
      });
    }

    for (const ob of zoneSnap.activeObs) {
      irlPools.push({
        id: ob.id,
        kind: "IRL_OB",
        price: ob.meanThreshold,
        top: ob.top,
        bottom: ob.bottom,
        isMitigated: ob.state === "CONSUMED" || ob.state === "INVALIDATED",
      });
    }

    // 3. Lecture 5 Trend-Aligned Objective Matrix
    const bias = biasSnap.bias;
    const trend = structSnap.trend;
    const dealingRange = biasSnap.dealingRange;

    // Gate 1: Check missing pillar
    if (bias === "UNKNOWN" || bias === "NEUTRAL" || trend === "NEUTRAL" || !dealingRange) {
      return {
        erlPoolCount: erlPools.length,
        irlPoolCount: irlPools.length,
        primaryTarget: null,
        intermediateTarget: null,
        invalidationLevel: null,
        alignmentStatus: "BLOCKED_MISSING_PILLAR",
        rationale: "Missing or unconfirmed pillar: bias is neutral/unknown, structure is choppy, or dealing range unformed.",
      };
    }

    // Gate 2: Bias vs Structure Directional Alignment
    if (bias !== trend) {
      return {
        erlPoolCount: erlPools.length,
        irlPoolCount: irlPools.length,
        primaryTarget: null,
        intermediateTarget: null,
        invalidationLevel: null,
        alignmentStatus: "BLOCKED_BIAS_STRUCTURE_DISAGREEMENT",
        rationale: `Bias (${bias}) conflicts with structure trend (${trend}). Execution gated.`,
      };
    }

    // Gate 3: Dealing Range & Objective Selection
    if (bias === "BULLISH") {
      // Must be in Discount (< 50% EQ) to buy
      if (dealingRange.isPremium(currentPrice)) {
        return {
          erlPoolCount: erlPools.length,
          irlPoolCount: irlPools.length,
          primaryTarget: null,
          intermediateTarget: null,
          invalidationLevel: null,
          alignmentStatus: "BLOCKED_PREMIUM_LONG",
          rationale: `Price (${currentPrice}) is in Premium (>= EQ ${dealingRange.equilibrium}). Long entries strictly prohibited in Premium.`,
        };
      }

      /*
       * The objective is EXTERNAL range liquidity, so it is the farthest unmitigated ERL beyond
       * equilibrium -- not the nearest pool above price.
       *
       * This used to ascending-sort and take [0], the CLOSEST pool above price, while
       * `invalidationLevel` below is the structural swing low and the entry is required to be in
       * Discount. Near reward against far risk makes R:R < 1 mechanical: measured over 45 days,
       * median R:R was 0.051 on BANKNIFTY and 0.174 on NIFTY50 against a 1.2 gate, so 19 of 405 and
       * 86 of 646 pillar-aligned bars could ever produce a trade.
       *
       * It also contradicted this function's own naming: `intermediateTarget` is equilibrium, a
       * waypoint the primary objective is supposed to lie beyond, yet the primary was nearer than
       * the intermediate on 80% of aligned bars. Requiring `price > equilibrium` makes that
       * invariant hold by construction rather than by luck.
       *
       * Null when no pool lies beyond equilibrium: there is no external objective, so
       * `coverage.liquidity` fails and the bar produces nothing. That is the honest outcome -- the
       * previous code would have offered a target inside the range instead.
       */
      const buyTargets = erlPools
        .filter((p) => !p.isMitigated && p.price > currentPrice && p.price > dealingRange.equilibrium)
        .sort((a, b) => b.price - a.price);

      const primaryTarget = buyTargets[0] || null;
      const intermediateTarget = dealingRange.equilibrium;

      // Invalidation: structural swing low or rangeLow
      const invalidationLevel = structSnap.lastHL?.price ?? dealingRange.rangeLow;

      return {
        erlPoolCount: erlPools.length,
        irlPoolCount: irlPools.length,
        primaryTarget,
        intermediateTarget,
        invalidationLevel,
        alignmentStatus: "ALIGNED_LONG",
        rationale: `Bullish 4-pillar alignment: Buying in Discount (< ${dealingRange.equilibrium}), targeting ERL ${primaryTarget?.kind ?? "rangeHigh"} at ${primaryTarget?.price ?? dealingRange.rangeHigh}.`,
      };
    } else {
      // BEARISH: Must be in Premium (>= 50% EQ) to sell
      if (dealingRange.isDiscount(currentPrice)) {
        return {
          erlPoolCount: erlPools.length,
          irlPoolCount: irlPools.length,
          primaryTarget: null,
          intermediateTarget: null,
          invalidationLevel: null,
          alignmentStatus: "BLOCKED_DISCOUNT_SHORT",
          rationale: `Price (${currentPrice}) is in Discount (< EQ ${dealingRange.equilibrium}). Short entries strictly prohibited in Discount.`,
        };
      }

      // Mirror of the bullish objective: farthest unmitigated ERL below equilibrium, not the
      // nearest pool below price. See the bullish branch for the measurement that motivated it.
      const sellTargets = erlPools
        .filter((p) => !p.isMitigated && p.price < currentPrice && p.price < dealingRange.equilibrium)
        .sort((a, b) => a.price - b.price);

      const primaryTarget = sellTargets[0] || null;
      const intermediateTarget = dealingRange.equilibrium;

      // Invalidation: structural swing high or rangeHigh
      const invalidationLevel = structSnap.lastLH?.price ?? dealingRange.rangeHigh;

      return {
        erlPoolCount: erlPools.length,
        irlPoolCount: irlPools.length,
        primaryTarget,
        intermediateTarget,
        invalidationLevel,
        alignmentStatus: "ALIGNED_SHORT",
        rationale: `Bearish 4-pillar alignment: Selling in Premium (>= ${dealingRange.equilibrium}), targeting ERL ${primaryTarget?.kind ?? "rangeLow"} at ${primaryTarget?.price ?? dealingRange.rangeLow}.`,
      };
    }
  }
}
