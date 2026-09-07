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
  readonly erlPools: readonly LiquidityPool[];
  readonly irlPools: readonly LiquidityPool[];
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
    sessionLevels: SessionLevelsSnapshot
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
    const confirmedPivots = structSnap.confirmedPivots || [];
    const highs = confirmedPivots.filter((p) => p.type === "HIGH");
    const lows = confirmedPivots.filter((p) => p.type === "LOW");

    for (let i = 0; i < highs.length - 1; i++) {
      for (let j = i + 1; j < highs.length; j++) {
        const diffBps = (Math.abs(highs[i].price - highs[j].price) / highs[i].price) * 10000;
        if (diffBps <= 5) {
          erlPools.push({
            id: `erl-eqh-${highs[i].index}-${highs[j].index}`,
            kind: "ERL_EQH",
            price: Math.max(highs[i].price, highs[j].price),
            isMitigated: currentPrice >= Math.max(highs[i].price, highs[j].price),
          });
        }
      }
    }

    for (let i = 0; i < lows.length - 1; i++) {
      for (let j = i + 1; j < lows.length; j++) {
        const diffBps = (Math.abs(lows[i].price - lows[j].price) / lows[i].price) * 10000;
        if (diffBps <= 5) {
          erlPools.push({
            id: `erl-eql-${lows[i].index}-${lows[j].index}`,
            kind: "ERL_EQL",
            price: Math.min(lows[i].price, lows[j].price),
            isMitigated: currentPrice <= Math.min(lows[i].price, lows[j].price),
          });
        }
      }
    }

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
        erlPools,
        irlPools,
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
        erlPools,
        irlPools,
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
          erlPools,
          irlPools,
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
        erlPools,
        irlPools,
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
          erlPools,
          irlPools,
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
        erlPools,
        irlPools,
        primaryTarget,
        intermediateTarget,
        invalidationLevel,
        alignmentStatus: "ALIGNED_SHORT",
        rationale: `Bearish 4-pillar alignment: Selling in Premium (>= ${dealingRange.equilibrium}), targeting ERL ${primaryTarget?.kind ?? "rangeLow"} at ${primaryTarget?.price ?? dealingRange.rangeLow}.`,
      };
    }
  }
}
