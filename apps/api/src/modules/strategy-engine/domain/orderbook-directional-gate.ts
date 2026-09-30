/**
 * ORDERBOOK-01 Directional Gate Domain Module.
 *
 * Enforces the frozen pre-registered ORDERBOOK-01 directional rules (Case A Verdict: 83.1% accuracy).
 * Evaluates whether proposed LONG or SHORT trade proposals align with L2 Depth Imbalance (DI_tilde > 0)
 * at structural levels.
 *
 * `confidenceAdjustment` is on the same 0-1 scale as `ProposedTradeIdea.confidence` (see
 * `momentum-scalp-strategy.ts`, `momentum-scalp-pattern-strategy.ts`, etc. -- every strategy in
 * this codebase clamps confidence to [0, 1]). It was previously +15/-30, sized as if confidence
 * were 0-100, and `applyOrderbookGateToProposal` clamped the result to [0, 100] to match --
 * meaning a live PASS or BLOCK verdict would have added or subtracted 15/30 *whole points* to a
 * score that lives between 0 and 1, and the clamp would not have caught it (0.63 - 30 clamps to 0,
 * not back to a sane fraction). Found 2026-09-30 while reviewing a momentum-scalp-pattern loss;
 * never yet triggered live because every recorded verdict so far has been NEUTRAL, which this
 * scale bug also produced 0 for, by coincidence rather than correctness.
 */

import type { ProposedTradeIdea, TradeSide } from "./strategy.js";

export interface OrderbookGateResult {
  isGateActive: boolean;
  nearestLevelType: string | null;
  nearestLevelPrice: number | null;
  distanceBps: number | null;
  rawDi: number | null;
  diTilde: number | null;
  directionalBias: "BULLISH_REJECTION" | "BEARISH_REJECTION" | "BEARISH_SWEEP" | "BULLISH_SWEEP" | "NONE";
  recommendedSide: "LONG" | "SHORT" | "NONE";
  gateStatus: "PASS" | "BLOCK" | "NEUTRAL";
  confidenceAdjustment: number; // 0-1 scale, matching ProposedTradeIdea.confidence: e.g. +0.15 for aligned, -0.30 for conflicting
  reasoning: string | null;
}

export function evaluateOrderbookDirectionalGate(
  side: TradeSide,
  confluenceSignal?: {
    is_level_proximate?: boolean;
    nearest_level_type?: string | null;
    nearest_level_price?: number | null;
    distance_bps?: number | null;
    raw_di?: number | null;
    di_tilde?: number | null;
    directional_bias?: string;
    gate_action?: string;
  } | null,
): OrderbookGateResult {
  if (!confluenceSignal || !confluenceSignal.is_level_proximate) {
    return {
      isGateActive: false,
      nearestLevelType: null,
      nearestLevelPrice: null,
      distanceBps: null,
      rawDi: null,
      diTilde: null,
      directionalBias: "NONE",
      recommendedSide: "NONE",
      gateStatus: "NEUTRAL",
      confidenceAdjustment: 0,
      reasoning: "No structural level proximate within bandwidth.",
    };
  }

  const action = confluenceSignal.gate_action || "NO_ACTION";
  const bias = (confluenceSignal.directional_bias || "NONE") as OrderbookGateResult["directionalBias"];
  const levelType = confluenceSignal.nearest_level_type || null;
  const levelPrice = confluenceSignal.nearest_level_price || null;
  const distBps = confluenceSignal.distance_bps || null;
  const rawDi = confluenceSignal.raw_di || null;
  const diTilde = confluenceSignal.di_tilde || null;

  let recommendedSide: "LONG" | "SHORT" | "NONE" = "NONE";
  if (action === "BUY_CALL_OR_LONG") {
    recommendedSide = "LONG";
  } else if (action === "BUY_PUT_OR_SHORT") {
    recommendedSide = "SHORT";
  }

  if (recommendedSide === "NONE") {
    return {
      isGateActive: true,
      nearestLevelType: levelType,
      nearestLevelPrice: levelPrice,
      distanceBps: distBps,
      rawDi,
      diTilde,
      directionalBias: bias,
      recommendedSide: "NONE",
      gateStatus: "NEUTRAL",
      confidenceAdjustment: 0,
      reasoning: `Near ${levelType} level but Orderbook DI is neutral.`,
    };
  }

  if (side === recommendedSide) {
    return {
      isGateActive: true,
      nearestLevelType: levelType,
      nearestLevelPrice: levelPrice,
      distanceBps: distBps,
      rawDi,
      diTilde,
      directionalBias: bias,
      recommendedSide,
      gateStatus: "PASS",
      confidenceAdjustment: 0.15,
      reasoning: `[ORDERBOOK-01 PASS] ${side} trade aligned with ${bias} at ${levelType} (${distBps} bps, DI_tilde=${diTilde}).`,
    };
  } else {
    return {
      isGateActive: true,
      nearestLevelType: levelType,
      nearestLevelPrice: levelPrice,
      distanceBps: distBps,
      rawDi,
      diTilde,
      directionalBias: bias,
      recommendedSide,
      gateStatus: "BLOCK",
      confidenceAdjustment: -0.30,
      reasoning: `[ORDERBOOK-01 BLOCK] ${side} trade conflicts with orderbook ${bias} at ${levelType} (recommended: ${recommendedSide}).`,
    };
  }
}

/** Applies ORDERBOOK-01 Directional Gate to a trade proposal and records shadow metadata. */
export function applyOrderbookGateToProposal(
  proposal: ProposedTradeIdea,
  confluenceSignal?: Parameters<typeof evaluateOrderbookDirectionalGate>[1],
): ProposedTradeIdea {
  const result = evaluateOrderbookDirectionalGate(proposal.side, confluenceSignal);
  const shadowVerdict = result.gateStatus === "PASS" ? "ALLOWED" : result.gateStatus === "BLOCK" ? "BLOCKED" : "NEUTRAL";
  
  const shadowGateData = {
    isGateActive: result.isGateActive,
    gateStatus: result.gateStatus,
    shadowVerdict,
    nearestLevelType: result.nearestLevelType,
    nearestLevelPrice: result.nearestLevelPrice,
    distanceBps: result.distanceBps,
    rawDi: result.rawDi,
    diTilde: result.diTilde,
    directionalBias: result.directionalBias,
    recommendedSide: result.recommendedSide,
    confidenceAdjustment: result.confidenceAdjustment,
  };

  if (!result.isGateActive || result.gateStatus === "NEUTRAL") {
    return {
      ...proposal,
      evidence: {
        ...proposal.evidence,
        orderbookGate: shadowGateData,
      },
    };
  }

  const updatedConfidence = Math.max(0, Math.min(1, proposal.confidence + result.confidenceAdjustment));

  return {
    ...proposal,
    confidence: updatedConfidence,
    reasoning: result.reasoning ? [...proposal.reasoning, result.reasoning] : proposal.reasoning,
    evidence: {
      ...proposal.evidence,
      orderbookGate: shadowGateData,
    },
  };
}

export interface DepthFrameLevelData {
  bidPrice?: number[];
  bidQty?: number[];
  askPrice?: number[];
  askQty?: number[];
  totalBuyQty?: number;
  totalSellQty?: number;
}

/**
 * Computes Distance-Weighted Decaying Depth Imbalance (DI_decay) across L2 orderbook levels.
 * Uses exponential distance decay lambda = 0.05 per basis point from mid-price.
 */
export function calculateDecayingDepthImbalance(
  depth: DepthFrameLevelData,
  lambdaBps: number = 0.05,
): { rawDi: number; decayingDi: number } {
  const totalBuy = depth.totalBuyQty ?? 0;
  const totalSell = depth.totalSellQty ?? 0;
  const rawDi = (totalBuy + totalSell) > 0 ? (totalBuy - totalSell) / (totalBuy + totalSell) : 0;

  const bidsP = depth.bidPrice ?? [];
  const bidsQ = depth.bidQty ?? [];
  const asksP = depth.askPrice ?? [];
  const asksQ = depth.askQty ?? [];

  if (bidsP.length === 0 || asksP.length === 0 || bidsQ.length === 0 || asksQ.length === 0) {
    return { rawDi, decayingDi: rawDi };
  }

  const bestBid = Number(bidsP[0]);
  const bestAsk = Number(asksP[0]);
  const midPrice = (bestBid + bestAsk) / 2;

  if (midPrice <= 0) return { rawDi, decayingDi: rawDi };

  let weightedBuySum = 0;
  let weightedSellSum = 0;

  for (let i = 0; i < Math.min(bidsP.length, bidsQ.length); i++) {
    const p = Number(bidsP[i]);
    const q = Number(bidsQ[i]);
    const distBps = (Math.abs(midPrice - p) / midPrice) * 10000;
    const w = Math.exp(-lambdaBps * distBps);
    weightedBuySum += q * w;
  }

  for (let j = 0; j < Math.min(asksP.length, asksQ.length); j++) {
    const p = Number(asksP[j]);
    const q = Number(asksQ[j]);
    const distBps = (Math.abs(p - midPrice) / midPrice) * 10000;
    const w = Math.exp(-lambdaBps * distBps);
    weightedSellSum += q * w;
  }

  const totalWeighted = weightedBuySum + weightedSellSum;
  const decayingDi = totalWeighted > 0 ? (weightedBuySum - weightedSellSum) / totalWeighted : rawDi;

  return { rawDi, decayingDi };
}

/** Resolves confluenceSignal from depth frame data and nearest structural level. */
export function resolveConfluenceSignalFromDepth(input: {
  nearestLevelType: string;
  nearestLevelPrice: number;
  distanceBps: number;
  depth: DepthFrameLevelData;
  bandwidthBps?: number;
}) {
  const bandwidthBps = input.bandwidthBps ?? 20.0;
  if (input.distanceBps > bandwidthBps) {
    return {
      is_level_proximate: false,
      nearest_level_type: input.nearestLevelType,
      nearest_level_price: input.nearestLevelPrice,
      distance_bps: input.distanceBps,
      raw_di: null,
      di_tilde: null,
      directional_bias: "NONE",
      gate_action: "NO_ACTION",
    };
  }

  const { rawDi, decayingDi } = calculateDecayingDepthImbalance(input.depth);
  const isTier1 = ["SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"].includes(input.nearestLevelType);
  const diTilde = isTier1 ? -decayingDi : decayingDi;

  let directional_bias = "NONE";
  let gate_action = "NO_ACTION";

  if (diTilde > 0) {
    if (isTier1) {
      if (input.nearestLevelType.includes("HIGH") || input.nearestLevelType === "ITH") {
        directional_bias = "BEARISH_REJECTION";
        gate_action = "BUY_PUT_OR_SHORT";
      } else {
        directional_bias = "BULLISH_REJECTION";
        gate_action = "BUY_CALL_OR_LONG";
      }
    } else {
      directional_bias = "BEARISH_SWEEP";
      gate_action = "BUY_PUT_OR_SHORT";
    }
  }

  return {
    is_level_proximate: true,
    nearest_level_type: input.nearestLevelType,
    nearest_level_price: input.nearestLevelPrice,
    distance_bps: input.distanceBps,
    raw_di: rawDi,
    decaying_di: decayingDi,
    di_tilde: diTilde,
    directional_bias,
    gate_action,
  };
}
