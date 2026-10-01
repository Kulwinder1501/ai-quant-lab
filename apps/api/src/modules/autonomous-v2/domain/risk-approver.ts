import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { decideCapacity } from "../../platform/risk/risk-primitives.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
import type { DualSidedEdgeAssessment } from "./edge-assessor.js";
import type { DualSidedThesis } from "./thesis-builder.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { approved, rejected, type EvaluationResult } from "./decision-outcome.js";

/**
 * P8: Risk -- the Brain-owned domain policy half of Readiness Plan Gap 2's split. The platform half
 * (`platform/risk/risk-primitives.ts`'s `decideCapacity`, `platform/risk/risk-snapshot.ts`'s
 * `InstrumentRiskSnapshot`) is structure and mechanism only, carrying no thresholds. This module is
 * where the thresholds live: Brain-specific risk policy, thesis-aware evaluation, and position sizing
 * policy, per Gap 2's "Brain P8" column.
 *
 * ## Reference, not import, for the tuned policy
 *
 * `risk-management/domain/risk.ts`'s `evaluateRisk`/`defaultRiskPolicy` is the behavioral rule this
 * re-derives (max concurrent positions, daily loss limit, max drawdown, fixed-fraction sizing floored
 * to whole lots, margin-fraction capital check) -- not imported, because it bakes in tuned V1 constants
 * and a mutable, non-four-outcome shape (`reasonCodes: string[]`, boolean `approved`). Same
 * "extract the behavior, don't copy verbatim" discipline P6b applied to ATR geometry: the starting
 * numbers below happen to match V1's, which is a reasonable baseline, but they are this module's own,
 * independently versioned.
 *
 * ## Why this stage never refuses (I6)
 *
 * I6 says the Risk Engine never creates directional signals -- it gates and sizes a side that already
 * exists, it does not pick one. A `DualSidedThesis`/`DualSidedEdgeAssessment` pair with both sides
 * already rejected upstream is still a fully evaluable (if vacuous) input, so the stage-level result is
 * always `APPROVED`. Per side, a side whose thesis or edge was not itself `APPROVED` has nothing to
 * gate, so that side's own result is `REJECTED` with a reason naming the absence.
 *
 * ## What is deliberately deferred, not omitted
 *
 * Volatility-regime size adjustment (V1's `expansionSizeMultiplier` under a point-in-time confidence
 * floor) and circuit-breaker integration are both named in Gap 2 as part of P8's eventual scope. Neither
 * is wired here: P6a's `volatilityRegime` shape does not match `risk-management`'s
 * `VolatilityRegimeEvidence`, and no circuit-breaker primitive exists in the platform yet. This is a
 * baseline, the same posture P7 took leaving `mlEdge: null` as a declared slot rather than pretending
 * the ML path doesn't exist.
 */

export const riskApprovalPolicyVersion = "NATIVE_RISK_APPROVAL_POLICY_V1";

// Native starting values, independently owned -- not imported from risk-management/domain/risk.ts.
const maxConcurrentPositions = 3;
const dailyLossLimitFraction = 0.02;
const maxDrawdownFraction = 0.1;
const riskFractionPerTrade = 0.005;
const marginFraction = 0.2;

export interface PositionSize {
  readonly quantity: number;
  readonly lotSize: number;
  readonly riskPerUnit: number;
  readonly estimatedRiskAmount: number;
  readonly notional: number;
  readonly capitalRequired: number;
}

export interface SideRiskApproval {
  readonly side: ThesisSide;
  readonly positionSize: PositionSize;
}

export type RiskRefusal =
  | "NO_APPROVED_EDGE_FOR_SIDE"
  | "MAX_CONCURRENT_POSITIONS"
  | "DAILY_LOSS_LIMIT"
  | "MAX_DRAWDOWN"
  | "RISK_BUDGET_BELOW_ONE_LOT"
  | "INSUFFICIENT_CAPITAL";

export type SideRiskResult = EvaluationResult<SideRiskApproval, RiskRefusal>;

export interface DualSidedRiskApproval {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly long: SideRiskResult;
  readonly short: SideRiskResult;
  readonly policyVersion: string;
}

/** Uninhabited: this stage never legitimately refuses at the stage level. See module docstring. */
export type RiskApproverRefusal = never;
export type RiskApproverResult = EvaluationResult<DualSidedRiskApproval, RiskApproverRefusal>;

export class RiskApproverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskApproverError";
  }
}

/**
 * The P8 proof: kind: "RISK_APPROVED", matching both decision-lifecycle.ts's wired vocabulary and the
 * frozen architecture doc's illustrative name -- unlike prior stages, no naming drift here.
 */
export interface RiskApproved {
  readonly kind: "RISK_APPROVED";
  readonly risk: DualSidedRiskApproval;
  readonly edge: DualSidedEdgeAssessment;
  readonly thesis: DualSidedThesis;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface RiskApprovalInput {
  readonly edge: DualSidedEdgeAssessment;
  readonly thesis: DualSidedThesis;
  readonly context: Readonly<BaseDecisionContext>;
  /** Caller-narrowed via the platform's `narrowToInstrument`; an already-resolved sibling input. */
  readonly accountSnapshot: InstrumentRiskSnapshot<unknown>;
  /** Instrument fact, threaded as a sibling input -- same posture as P6b's `tickSize`. */
  readonly lotSize: number;
}

function assessSide(
  side: ThesisSide,
  input: RiskApprovalInput,
): SideRiskResult {
  const edgeSide = side === "LONG" ? input.edge.long : input.edge.short;
  const thesisSide = side === "LONG" ? input.thesis.long : input.thesis.short;
  if (edgeSide.outcome !== "APPROVED" || thesisSide.outcome !== "APPROVED") {
    return rejected(["NO_APPROVED_EDGE_FOR_SIDE"]);
  }

  const snapshot = input.accountSnapshot;
  const reasons: RiskRefusal[] = [];

  const capacity = decideCapacity({ used: snapshot.openPositionCount, cap: maxConcurrentPositions });
  if (!capacity.allowed) reasons.push("MAX_CONCURRENT_POSITIONS");

  if (snapshot.realizedPnlToday <= -Math.abs(snapshot.accountEquity * dailyLossLimitFraction)) {
    reasons.push("DAILY_LOSS_LIMIT");
  }

  if (snapshot.peakEquity > 0) {
    const drawdown = (snapshot.peakEquity - snapshot.accountEquity) / snapshot.peakEquity;
    if (drawdown >= maxDrawdownFraction) reasons.push("MAX_DRAWDOWN");
  }

  if (reasons.length > 0) return rejected(reasons);

  const geometry = thesisSide.value;
  const riskPerUnit = Math.abs(geometry.entryReference - geometry.stopLoss);
  const riskBudget = snapshot.accountEquity * riskFractionPerTrade;
  const affordableUnits = Math.floor(riskBudget / riskPerUnit);
  const quantity = Math.floor(affordableUnits / input.lotSize) * input.lotSize;

  if (quantity < input.lotSize) {
    return rejected(["RISK_BUDGET_BELOW_ONE_LOT"]);
  }

  const notional = quantity * geometry.entryReference;
  const capitalRequired = notional * marginFraction;
  if (capitalRequired > snapshot.accountEquity) {
    return rejected(["INSUFFICIENT_CAPITAL"]);
  }

  return approved(Object.freeze({
    side,
    positionSize: Object.freeze({
      quantity,
      lotSize: input.lotSize,
      riskPerUnit,
      estimatedRiskAmount: quantity * riskPerUnit,
      notional,
      capitalRequired,
    }),
  }));
}

/**
 * Gates and sizes both sides of a thesis independently. Total by construction: the throws below are
 * caller/data defects, never a business refusal -- this stage has no rule that refuses a well-formed
 * thesis/edge pair, whatever its two sides individually resolved to.
 */
export function approveRisk(input: RiskApprovalInput): RiskApproverResult {
  if (!Number.isInteger(input.lotSize) || input.lotSize <= 0) {
    throw new RiskApproverError("lotSize must be a positive integer.");
  }
  if (!Number.isFinite(input.accountSnapshot.accountEquity) || input.accountSnapshot.accountEquity <= 0) {
    throw new RiskApproverError("accountSnapshot.accountEquity must be a finite, positive number.");
  }
  if (input.edge.instrumentSymbol !== input.thesis.instrumentSymbol) {
    throw new RiskApproverError(
      `edge.instrumentSymbol (${input.edge.instrumentSymbol}) does not match `
      + `thesis.instrumentSymbol (${input.thesis.instrumentSymbol}).`,
    );
  }
  if (input.edge.decisionAt.getTime() !== input.thesis.decisionAt.getTime()) {
    throw new RiskApproverError("edge.decisionAt does not match thesis.decisionAt.");
  }

  const long = assessSide("LONG", input);
  const short = assessSide("SHORT", input);

  return approved(Object.freeze({
    instrumentSymbol: input.thesis.instrumentSymbol,
    decisionAt: input.thesis.decisionAt,
    observedIn: input.thesis.observedIn,
    long,
    short,
    policyVersion: riskApprovalPolicyVersion,
  }));
}
