/**
 * ORDERBOOK-01 Directional Gate Domain Module.
 *
 * Enforces the frozen pre-registered ORDERBOOK-01 directional rules (Case A Verdict: 83.1% accuracy).
 * Evaluates whether proposed LONG or SHORT trade proposals align with L2 Depth Imbalance (DI_tilde > 0)
 * at structural levels.
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
  confidenceAdjustment: number; // e.g. +15 for aligned, -30 for conflicting
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
      confidenceAdjustment: 15,
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
      confidenceAdjustment: -30,
      reasoning: `[ORDERBOOK-01 BLOCK] ${side} trade conflicts with orderbook ${bias} at ${levelType} (recommended: ${recommendedSide}).`,
    };
  }
}

/** Applies ORDERBOOK-01 Directional Gate to a trade proposal. */
export function applyOrderbookGateToProposal(
  proposal: ProposedTradeIdea,
  confluenceSignal?: Parameters<typeof evaluateOrderbookDirectionalGate>[1],
): ProposedTradeIdea {
  const result = evaluateOrderbookDirectionalGate(proposal.side, confluenceSignal);
  if (!result.isGateActive || result.gateStatus === "NEUTRAL") {
    return proposal;
  }

  const updatedConfidence = Math.max(0, Math.min(100, proposal.confidence + result.confidenceAdjustment));

  return {
    ...proposal,
    confidence: updatedConfidence,
    reasoning: result.reasoning ? [...proposal.reasoning, result.reasoning] : proposal.reasoning,
  };
}
