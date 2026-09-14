import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { breakEvenHitRate } from "../../strategy-engine/domain/bracket-outcome.js";
import { roundTripCostR } from "../../backtesting/domain/round-trip-cost.js";
import type { DualSidedThesis } from "./thesis-builder.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { approved, type EvaluationResult } from "./decision-outcome.js";

/**
 * P7: the Edge Engine's deterministic baseline (no ML path -- P15 is Tier 3, on hold indefinitely per
 * the readiness plan, since no directional target has cleared its own cost-aware gate).
 *
 * ## What "deterministic, falsifiable edge measurement" means here
 *
 * Not a probability of success -- that needs historical data or ML, neither in scope. Instead: a
 * cost-adjusted breakeven hit-rate requirement, derived purely from a side's own geometry plus a
 * declared transaction-cost assumption. It is falsifiable in the plain sense that a future real
 * measurement of how often this geometry actually resolves in profit can be checked against the number
 * computed here, and the number itself never changes for the same inputs.
 *
 * Two existing, quarantine-clean, fully parameterized functions do the arithmetic --
 * `breakEvenHitRate` (`strategy-engine/domain/bracket-outcome.ts`) and `roundTripCostR`
 * (`backtesting/domain/round-trip-cost.ts`). Both are imported directly rather than re-derived: unlike
 * P6b's ATR geometry, neither bakes in a tuned V1 policy constant -- the caller supplies every
 * parameter, so importing them does not smuggle a V1 assumption into V2.2.
 *
 * `costAdjustedBreakEvenHitRate = (1 + roundTripCostR) / (1 + rewardRiskMultiple)`, which reduces
 * exactly to `breakEvenHitRate(rewardRiskMultiple)` when cost is zero. `rewardRiskMultiple` is measured
 * from the side's own stored prices rather than assumed, even though every `SideGeometry` P6b currently
 * produces happens to carry the same ratio.
 *
 * ## Why the cost assumption is an input, not a constant
 *
 * Real transaction cost varies by broker and instrument, so `costBps` is threaded into
 * `EdgeAssessmentInput` by the caller -- the same "already-resolved sibling" convention every prior
 * stage has used for external facts (P5's `patternCoverage`, P6a's `volatilityReading`, P6b's
 * `atrValue`/`entryReference`) -- rather than inventing one number and baking it in.
 *
 * ## Why this stage never refuses (I5)
 *
 * I5 says the Edge Engine never modifies risk limits -- it measures, it does not gate; that is P8
 * Risk's job. A `DualSidedThesis` with both sides rejected is still a fully measurable (if vacuous)
 * input, so the stage-level result is always `APPROVED`. Per-side, a side whose thesis was not itself
 * `APPROVED` has no geometry to measure, so that side's own result is `REJECTED` with a reason that
 * names the absence, not a re-statement of `SideRefusal`'s specific cause.
 *
 * ## The ML slot is declared, not omitted
 *
 * `mlEdge: null` on every side, matching P6a's `directionEvidenceCoverage` convention: the type does
 * not need a breaking change whenever P15 eventually starts.
 */

export const edgeAssessmentPolicyVersion = "NATIVE_EDGE_ASSESSMENT_POLICY_V1";

export interface BaselineEdge {
  readonly rewardRiskMultiple: number;
  readonly frictionlessBreakEvenHitRate: number;
  readonly roundTripCostR: number;
  readonly costAdjustedBreakEvenHitRate: number;
  /** The declared assumption used, carried for replay. */
  readonly costBps: number;
}

export interface SideEdgeAssessment {
  readonly side: ThesisSide;
  readonly baselineEdge: BaselineEdge;
  /** P15 (ML Edge) is Tier 3, on hold -- no defensible directional target yet. Declared, not omitted. */
  readonly mlEdge: null;
}

export type EdgeRefusal = "NO_APPROVED_THESIS_FOR_SIDE";
export type SideEdgeResult = EvaluationResult<SideEdgeAssessment, EdgeRefusal>;

export interface DualSidedEdgeAssessment {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly long: SideEdgeResult;
  readonly short: SideEdgeResult;
  readonly policyVersion: string;
}

/** Uninhabited: this stage never legitimately refuses at the stage level. See module docstring. */
export type EdgeAssessorRefusal = never;
export type EdgeAssessorResult = EvaluationResult<DualSidedEdgeAssessment, EdgeAssessorRefusal>;

export class EdgeAssessorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeAssessorError";
  }
}

/**
 * The P7 proof: kind: "EDGE_ASSESSED", matching decision-lifecycle.ts's wired vocabulary, not the
 * frozen architecture doc's illustrative "EDGE_APPROVED" -- same precedent every prior stage applied.
 */
export interface EdgeAssessed {
  readonly kind: "EDGE_ASSESSED";
  readonly edge: DualSidedEdgeAssessment;
  readonly thesis: DualSidedThesis;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface EdgeAssessmentInput {
  readonly thesis: DualSidedThesis;
  readonly context: Readonly<BaseDecisionContext>;
  /** Declared cost assumption, one-way basis points of notional, charged twice per round trip. */
  readonly costBps: number;
}

function assessSide(side: ThesisSide, thesis: DualSidedThesis, costBps: number): SideEdgeResult {
  const sideThesis = side === "LONG" ? thesis.long : thesis.short;
  if (sideThesis.outcome !== "APPROVED") {
    return { outcome: "REJECTED", reasons: ["NO_APPROVED_THESIS_FOR_SIDE"] };
  }

  const geometry = sideThesis.value;
  const riskPerUnit = Math.abs(geometry.entryReference - geometry.stopLoss);
  const rewardPerUnit = Math.abs(geometry.targetPrice - geometry.entryReference);
  const rewardRiskMultiple = rewardPerUnit / riskPerUnit;

  const frictionlessBreakEvenHitRate = breakEvenHitRate(rewardRiskMultiple);
  const costR = roundTripCostR({
    riskPerUnit,
    entryPrice: geometry.entryReference,
    costBps,
  });
  const costAdjustedBreakEvenHitRate = (1 + costR) / (1 + rewardRiskMultiple);

  return approved(Object.freeze({
    side,
    baselineEdge: Object.freeze({
      rewardRiskMultiple,
      frictionlessBreakEvenHitRate,
      roundTripCostR: costR,
      costAdjustedBreakEvenHitRate,
      costBps,
    }),
    mlEdge: null,
  }));
}

/**
 * Assesses baseline edge for both sides of a thesis independently. Total by construction: the throws
 * below are caller/data defects, never a business refusal -- this stage has no rule that refuses a
 * well-formed thesis, whatever its two sides individually resolved to.
 */
export function assessEdge(input: EdgeAssessmentInput): EdgeAssessorResult {
  if (!Number.isFinite(input.costBps) || input.costBps < 0) {
    throw new EdgeAssessorError("costBps must be a non-negative, finite number.");
  }
  if (Number.isNaN(input.context.decisionAt.getTime())) {
    throw new EdgeAssessorError("context.decisionAt must be a valid Date.");
  }

  const long = assessSide("LONG", input.thesis, input.costBps);
  const short = assessSide("SHORT", input.thesis, input.costBps);

  return approved(Object.freeze({
    instrumentSymbol: input.thesis.instrumentSymbol,
    decisionAt: input.thesis.decisionAt,
    observedIn: input.thesis.observedIn,
    long,
    short,
    policyVersion: edgeAssessmentPolicyVersion,
  }));
}
