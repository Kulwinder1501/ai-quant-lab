import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/**
 * Reason codes. Every rejection names one, and approvals name the checks that shaped
 * the size, so a decision is readable after the fact without re-deriving it.
 */
export const riskReasonCodes = {
  approved: "APPROVED",
  invalidGeometry: "REJECTED_INVALID_GEOMETRY",
  unsizable: "REJECTED_RISK_BUDGET_BELOW_ONE_UNIT",
  belowOneLot: "REJECTED_RISK_BUDGET_BELOW_ONE_LOT",
  sizeFlooredToLot: "SIZE_FLOORED_TO_LOT_MULTIPLE",
  maxConcurrentPositions: "REJECTED_MAX_CONCURRENT_POSITIONS",
  dailyLossLimit: "REJECTED_DAILY_LOSS_LIMIT",
  maxDrawdown: "REJECTED_MAX_DRAWDOWN",
  insufficientCapital: "REJECTED_INSUFFICIENT_CAPITAL",
  regimeFromFuture: "REJECTED_REGIME_EVIDENCE_FROM_FUTURE",
  sizeReducedForExpansion: "SIZE_REDUCED_PREDICTED_VOLATILITY_EXPANSION",
  regimeIgnoredLowConfidence: "REGIME_IGNORED_BELOW_CONFIDENCE_FLOOR",
  regimeUnavailable: "REGIME_UNAVAILABLE",
} as const;

export type VolatilityRegime = "CONTRACTION" | "STABLE" | "EXPANSION";

/**
 * A non-directional volatility prediction, read from `auxiliary_model_predictions`.
 *
 * This is the only measured signal in the repository, and it is a position-sizing and
 * regime-gating signal rather than a directional edge -- it says nothing about which
 * way price will go. It is therefore consumed here, where size is decided, and never
 * as a reason to take one side over the other.
 */
export interface VolatilityRegimeEvidence {
  prediction: VolatilityRegime;
  confidence: number;
  /** The as-of boundary the prediction was made under. */
  evidenceCutoffAt: Date;
}

export interface RiskProposal {
  instrumentId: string;
  decisionTimestamp: Date;
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  /**
   * Units per lot, from `instruments.lot_size`. Defaults to 1 for instruments that
   * trade in single units.
   *
   * Without this, the engine solved for an arbitrary unit count -- 2053 units of a
   * 75-unit-lot instrument -- which `validateQuantity` then refused, so every approved
   * F&O trade failed to open. The size is floored to a whole lot, never rounded:
   * rounding up would put more capital at risk than the policy allows, which is the
   * one thing this engine exists to prevent.
   */
  lotSize?: number;
}

export interface RiskState {
  /** Realised equity now. */
  accountEquity: number;
  /** Highest realised equity reached, for the drawdown check. */
  peakEquity: number;
  openPositionCount: number;
  /** Realised P&L booked today, negative when losing. */
  realizedPnlToday: number;
  volatilityRegime: VolatilityRegimeEvidence | null;
}

export interface RiskPolicy {
  /** Fraction of equity risked per trade before any regime adjustment. */
  riskFractionPerTrade: number;
  maxConcurrentPositions: number;
  /** Daily realised loss, as a fraction of equity, that halts new entries. */
  dailyLossLimitFraction: number;
  /** Drawdown from peak equity that halts new entries. */
  maxDrawdownFraction: number;
  /** Fraction of notional that must be available as capital. 1 is cash-secured. */
  marginFraction: number;
  /** Size multiplier applied when expansion is predicted with enough confidence. */
  expansionSizeMultiplier: number;
  /** Below this confidence the regime is treated as unknown rather than acted on. */
  minimumRegimeConfidence: number;
}

/**
 * Deliberately conservative. Sizing at 0.5% with a 20% margin allowance mirrors the
 * backtest engine's settings, so a risk decision here and a backtest of the same rule
 * are describing the same account. The expansion multiplier halves size rather than
 * blocking: predicted expansion makes a fixed stop likelier to be hit, which is a
 * reason to commit less, not a reason to believe the trade is wrong.
 */
export const defaultRiskPolicy: RiskPolicy = {
  riskFractionPerTrade: 0.005,
  maxConcurrentPositions: 3,
  dailyLossLimitFraction: 0.02,
  maxDrawdownFraction: 0.1,
  marginFraction: 0.2,
  expansionSizeMultiplier: 0.5,
  minimumRegimeConfidence: 0.5,
};

export interface RiskDecision {
  approved: boolean;
  reasonCodes: string[];
  approvedQuantity: number;
  approvedEntryPrice: number | null;
  approvedStopLoss: number | null;
  approvedTargetPrice: number | null;
  estimatedRiskAmount: number;
  portfolioExposureAfterTrade: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function isGeometryCoherent(proposal: RiskProposal): boolean {
  const values = [proposal.entryPrice, proposal.stopLoss, proposal.targetPrice];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return false;
  return proposal.side === "LONG"
    ? proposal.stopLoss < proposal.entryPrice && proposal.entryPrice < proposal.targetPrice
    : proposal.targetPrice < proposal.entryPrice && proposal.entryPrice < proposal.stopLoss;
}

function rejection(reasonCodes: string[]): RiskDecision {
  return {
    approved: false,
    reasonCodes,
    approvedQuantity: 0,
    approvedEntryPrice: null,
    approvedStopLoss: null,
    approvedTargetPrice: null,
    estimatedRiskAmount: 0,
    portfolioExposureAfterTrade: 0,
  };
}

/**
 * The final approval layer before a paper trade may be executed.
 *
 * **Rejection is the default.** Nothing is approved because no check objected; a
 * proposal is approved only after every mandatory check has passed and a whole-unit
 * size has been solved for. Every path that returns early returns a rejection, so a
 * check added later cannot accidentally leave a trade approved.
 *
 * This does not decide direction, and it cannot: the proposal arrives with a side
 * already chosen. It decides *whether* and *how much*.
 */
export function evaluateRisk(
  proposal: RiskProposal,
  state: RiskState,
  policy: RiskPolicy = defaultRiskPolicy,
): RiskDecision {
  const reasonCodes: string[] = [];

  if (!isGeometryCoherent(proposal)) {
    return rejection([riskReasonCodes.invalidGeometry]);
  }
  if (!Number.isFinite(state.accountEquity) || state.accountEquity <= 0) {
    return rejection([riskReasonCodes.insufficientCapital]);
  }

  if (state.openPositionCount >= policy.maxConcurrentPositions) {
    reasonCodes.push(riskReasonCodes.maxConcurrentPositions);
  }
  if (state.realizedPnlToday <= -Math.abs(state.accountEquity * policy.dailyLossLimitFraction)) {
    reasonCodes.push(riskReasonCodes.dailyLossLimit);
  }
  if (state.peakEquity > 0) {
    const drawdown = (state.peakEquity - state.accountEquity) / state.peakEquity;
    if (drawdown >= policy.maxDrawdownFraction) {
      reasonCodes.push(riskReasonCodes.maxDrawdown);
    }
  }

  // Point-in-time. A prediction whose evidence closes after the decision could not
  // have been available when the decision was made, and acting on it would be
  // leakage rather than caution.
  let riskFraction = policy.riskFractionPerTrade;
  const regime = state.volatilityRegime;
  if (regime === null) {
    reasonCodes.push(riskReasonCodes.regimeUnavailable);
  } else if (regime.evidenceCutoffAt.getTime() > proposal.decisionTimestamp.getTime()) {
    reasonCodes.push(riskReasonCodes.regimeFromFuture);
  } else if (regime.confidence < policy.minimumRegimeConfidence) {
    reasonCodes.push(riskReasonCodes.regimeIgnoredLowConfidence);
  } else if (regime.prediction === "EXPANSION") {
    riskFraction *= policy.expansionSizeMultiplier;
    reasonCodes.push(riskReasonCodes.sizeReducedForExpansion);
  }

  const lotSize = proposal.lotSize ?? 1;
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    return rejection([riskReasonCodes.invalidGeometry]);
  }

  const riskPerUnit = Math.abs(proposal.entryPrice - proposal.stopLoss);
  const riskBudget = state.accountEquity * riskFraction;
  const affordableUnits = Math.floor(riskBudget / riskPerUnit);
  // Floored to whole lots, so realised risk stays at or under the budget. Rounding to
  // the nearest lot could exceed it.
  const quantity = Math.floor(affordableUnits / lotSize) * lotSize;
  if (affordableUnits < 1) {
    reasonCodes.push(riskReasonCodes.unsizable);
  } else if (quantity < lotSize) {
    // The budget buys units but not a whole lot, which is a different problem from
    // buying nothing at all: the instrument is tradable, this account cannot take one
    // lot of it at this risk fraction.
    reasonCodes.push(riskReasonCodes.belowOneLot);
  } else if (quantity !== affordableUnits) {
    reasonCodes.push(riskReasonCodes.sizeFlooredToLot);
  }

  const notional = quantity * proposal.entryPrice;
  const capitalRequired = notional * policy.marginFraction;
  if (quantity >= 1 && capitalRequired > state.accountEquity) {
    reasonCodes.push(riskReasonCodes.insufficientCapital);
  }

  const blocking = reasonCodes.filter((code) => code.startsWith("REJECTED_"));
  if (blocking.length > 0) {
    return rejection(reasonCodes);
  }

  return {
    approved: true,
    reasonCodes: [riskReasonCodes.approved, ...reasonCodes],
    approvedQuantity: quantity,
    approvedEntryPrice: proposal.entryPrice,
    approvedStopLoss: proposal.stopLoss,
    approvedTargetPrice: proposal.targetPrice,
    estimatedRiskAmount: rounded(quantity * riskPerUnit),
    portfolioExposureAfterTrade: rounded(capitalRequired),
  };
}
