/**
 * ORDERBOOK-01 Directional Gate Domain Module.
 *
 * Evaluates whether proposed LONG or SHORT trade proposals align with L2 Depth Imbalance (DI_tilde > 0)
 * at structural levels.
 *
 * STATUS (2026-10): the ORDERBOOK-01 hypothesis was FALSIFIED out of sample (CASE E, see
 * docs/2026-10-05-orderbook01-bug-fixes-and-honest-verdict.md). The gate is therefore SHADOW-ONLY by
 * default. `ORDERBOOK01_LIVE_GATE_ENABLED === "true"` is the single kill switch for every
 * live effect of this module: the options-entry validator blocks on it, and
 * `applyOrderbookGateToProposal` only moves `ProposedTradeIdea.confidence` when it is set. With the
 * switch off the verdict is still computed and recorded in `evidence.orderbookGate`, so shadow
 * P&L keeps being measured, but nothing downstream can be gated by it. (Before 2026-10-10 the
 * confidence adjustment was applied unconditionally; because the options-entry validator requires
 * confidence >= 0.6, a -0.30 "BLOCK" adjustment silently gated trades even with the switch off.)
 *
 * ## DI standardisation (causal, within-day)
 *
 * Raw DI = (total_buy_qty - total_sell_qty) / (total_buy_qty + total_sell_qty) is almost a per-day
 * constant: on most days total_buy_qty > total_sell_qty in only 0-2% of frames (mean DI -0.15 to
 * -0.41), so `rawDi < 0` -- i.e. `di_tilde = -rawDi > 0` -- is effectively "always true" or
 * "always false" for a whole day and carries no information about the moment of contact.
 * `di_tilde` is therefore built from the DI **detrended by its trailing causal mean**:
 *
 *   di_tilde = -(rawDi - mean(rawDi over the previous DI_STANDARDISATION_WINDOW_MINUTES complete minutes))
 *
 * The window (30 minutes, minimum 10 populated minutes) is a documented a-priori choice, not tuned
 * against outcomes. Only data strictly BEFORE the current minute is ever used. When the depth frame,
 * its totals, or enough history is unavailable the signal is `null` (status UNAVAILABLE_*), never 0.
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

/** Same semantics as the options-entry validator: only the exact string "true" enables live effects. */
export function isOrderbook01LiveGateEnabled(): boolean {
  return process.env.ORDERBOOK01_LIVE_GATE_ENABLED === "true";
}

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
  // Explicit null checks, never `||`: `||` turns a real 0 (a legitimate raw DI of exactly 0, or a
  // distance of 0 bps) into null, erasing a genuine measurement.
  const levelType = confluenceSignal.nearest_level_type ?? null;
  const levelPrice = confluenceSignal.nearest_level_price ?? null;
  const distBps = confluenceSignal.distance_bps ?? null;
  const rawDi = confluenceSignal.raw_di ?? null;
  const diTilde = confluenceSignal.di_tilde ?? null;

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

/**
 * Applies the ORDERBOOK-01 Directional Gate to a trade proposal.
 *
 * The verdict is ALWAYS recorded as shadow data in `evidence.orderbookGate`. The confidence
 * adjustment and the extra reasoning line are applied to the proposal ONLY when the kill switch
 * `ORDERBOOK01_LIVE_GATE_ENABLED === "true"` is set (default OFF, hypothesis falsified).
 */
export function applyOrderbookGateToProposal(
  proposal: ProposedTradeIdea,
  confluenceSignal?: Parameters<typeof evaluateOrderbookDirectionalGate>[1],
): ProposedTradeIdea {
  const result = evaluateOrderbookDirectionalGate(proposal.side, confluenceSignal);
  const shadowVerdict = result.gateStatus === "PASS" ? "ALLOWED" : result.gateStatus === "BLOCK" ? "BLOCKED" : "NEUTRAL";
  const liveGateEnabled = isOrderbook01LiveGateEnabled();
  const adjustmentApplied = liveGateEnabled && result.isGateActive && result.gateStatus !== "NEUTRAL";

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
    /** The adjustment the gate WOULD make; applied to confidence only when `liveGateEnabled`. */
    confidenceAdjustment: result.confidenceAdjustment,
    liveGateEnabled,
    adjustmentApplied,
  };

  if (!adjustmentApplied) {
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
  totalBuyQty?: number | null;
  totalSellQty?: number | null;
}

/**
 * Computes Distance-Weighted Decaying Depth Imbalance (DI_decay) across L2 orderbook levels.
 * Uses exponential distance decay lambda = 0.05 per basis point from mid-price.
 *
 * `rawDi` is `null` (not 0) when the frame carries no usable totals: a missing/zero-total frame
 * is "unavailable", and a fabricated 0 would read as a perfectly balanced book.
 */
export function calculateDecayingDepthImbalance(
  depth: DepthFrameLevelData,
  lambdaBps: number = 0.05,
): { rawDi: number | null; decayingDi: number | null } {
  const totalBuy = depth.totalBuyQty;
  const totalSell = depth.totalSellQty;
  const hasTotals =
    totalBuy !== null && totalBuy !== undefined && Number.isFinite(totalBuy) &&
    totalSell !== null && totalSell !== undefined && Number.isFinite(totalSell) &&
    totalBuy + totalSell > 0;
  const rawDi = hasTotals ? (totalBuy! - totalSell!) / (totalBuy! + totalSell!) : null;

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

  if (!(midPrice > 0)) return { rawDi, decayingDi: rawDi };

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

// ─────────────────────────── Causal within-day DI standardisation ─────────────────────────────

/** Trailing window of complete prior minutes whose mean is subtracted from the current raw DI. */
export const DI_STANDARDISATION_WINDOW_MINUTES = 30;
/** Minimum populated prior minutes required before a standardised DI is published. */
export const DI_STANDARDISATION_MIN_HISTORY_MINUTES = 10;
/** Below this std the z-score is undefined (flat history) and reported as null. */
const DI_STD_EPSILON = 1e-9;

export interface CausalDiStandardisation {
  readonly status: "OK" | "UNAVAILABLE_DEPTH" | "UNAVAILABLE_HISTORY";
  /** rawDi minus the trailing causal mean; null unless status is OK. */
  readonly detrendedDi: number | null;
  /** detrendedDi / trailing std; null unless status OK and the history has non-zero spread. */
  readonly zScore: number | null;
  readonly trailingMean: number | null;
  readonly historyCount: number;
}

/**
 * Causal standardisation of one raw DI observation against its own trailing history.
 *
 * `priorMinuteDi` MUST contain only DI samples observed strictly before the observation (callers
 * build it with `trailingMinuteDiSamples`). Non-finite entries are dropped. Returns UNAVAILABLE_*
 * (all-null) rather than 0 when the raw DI or enough history is missing.
 */
export function causalStandardiseDi(
  rawDi: number | null | undefined,
  priorMinuteDi: readonly number[] | null | undefined,
  minHistory: number = DI_STANDARDISATION_MIN_HISTORY_MINUTES,
): CausalDiStandardisation {
  if (rawDi === null || rawDi === undefined || !Number.isFinite(rawDi)) {
    return { status: "UNAVAILABLE_DEPTH", detrendedDi: null, zScore: null, trailingMean: null, historyCount: 0 };
  }
  const history = (priorMinuteDi ?? []).filter((v) => Number.isFinite(v));
  if (history.length < minHistory || history.length === 0) {
    return { status: "UNAVAILABLE_HISTORY", detrendedDi: null, zScore: null, trailingMean: null, historyCount: history.length };
  }
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const std = Math.sqrt(variance);
  const detrended = rawDi - mean;
  return {
    status: "OK",
    detrendedDi: detrended,
    zScore: std > DI_STD_EPSILON ? detrended / std : null,
    trailingMean: mean,
    historyCount: history.length,
  };
}

/**
 * Builds the causal history for `causalStandardiseDi`: the LAST raw DI of each complete minute in
 * `[floor(asOf) - windowMinutes, floor(asOf))` -- strictly before the minute that contains `asOf`,
 * so the current minute (and anything after `asOf`) is never used. Frames with a null raw DI are
 * skipped, not zero-filled. Output is ordered oldest -> newest.
 */
export function trailingMinuteDiSamples(
  frames: ReadonlyArray<{ receivedAt: Date; rawDi: number | null }>,
  asOf: Date,
  windowMinutes: number = DI_STANDARDISATION_WINDOW_MINUTES,
): number[] {
  const minuteMs = 60_000;
  const currentMinute = Math.floor(asOf.getTime() / minuteMs);
  const firstMinute = currentMinute - windowMinutes;
  const lastPerMinute = new Map<number, { t: number; di: number }>();
  for (const f of frames) {
    if (f.rawDi === null || !Number.isFinite(f.rawDi)) continue;
    const t = f.receivedAt.getTime();
    const minute = Math.floor(t / minuteMs);
    if (minute < firstMinute || minute >= currentMinute) continue;
    const existing = lastPerMinute.get(minute);
    if (!existing || t >= existing.t) lastPerMinute.set(minute, { t, di: f.rawDi });
  }
  return [...lastPerMinute.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.di);
}

/**
 * Resolves confluenceSignal from depth frame data and nearest structural level.
 *
 * `priorMinuteDi` is the causal trailing history (see `trailingMinuteDiSamples`). Without it the
 * DI cannot be standardised and `di_tilde` is `null` (gate NO_ACTION) -- the un-standardised raw
 * sign is a per-day constant and is deliberately NOT used as a fallback.
 */
export function resolveConfluenceSignalFromDepth(input: {
  nearestLevelType: string;
  nearestLevelPrice: number;
  distanceBps: number;
  depth: DepthFrameLevelData;
  bandwidthBps?: number;
  priorMinuteDi?: readonly number[] | null;
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
  const standardised = causalStandardiseDi(rawDi, input.priorMinuteDi);
  const isTier1 = ["SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"].includes(input.nearestLevelType);
  // DI_tilde = -(standardised DI) uniformly across BOTH tiers, matching the frozen OOS validator
  // (apps/ml/run_orderbook01_oos.py: `di_tilde = -di` in match_events_to_depth, applied to
  // Tier 1 and Tier 2/PDL alike -- see the module docstring's Tier 1/Tier 2 sections, both of
  // which state "DI_tilde = -DI"). This gate previously negated only for Tier 1
  // (`isTier1 ? -rawDi : rawDi`), leaving Tier 2 (PDL) on the raw, un-negated sign -- i.e. the
  // opposite convention from what was actually backtested. Git history (introduced in
  // 8f9930a2, "wire runtime L2 depth buffer... and implement distance-weighted decaying DI")
  // shows no documented reason for the asymmetry; it was a bug, not a deliberate choice.
  // The standardisation (trailing causal mean subtracted) is applied BEFORE negating and taking
  // the sign; see the module header.
  const diTilde = standardised.detrendedDi === null ? null : -standardised.detrendedDi;

  let directional_bias = "NONE";
  let gate_action = "NO_ACTION";

  if (diTilde !== null && diTilde > 0) {
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
    di_z_score: standardised.zScore,
    di_status: standardised.status,
    directional_bias,
    gate_action,
  };
}
