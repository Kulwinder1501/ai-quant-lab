import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { logicalKey } from "../../platform/identity/identity.js";
import type { OpportunityCandidate } from "./opportunity-resolver.js";
import type { BaseDecisionContext } from "./decision-context.js";
import type { ThesisSide } from "./thesis-producer.js";
import {
  approved,
  deferred,
  type EvaluationResult,
  type NotApproved,
} from "./decision-outcome.js";

/**
 * A native Thesis Builder (P6b): both LONG and SHORT recorded, neither picked over the other.
 *
 * ## Why this is a new file, not a change to thesis-producer.ts
 *
 * `thesis-producer.ts`'s `NativeThesis` is single-sided by design, and `structuralGateThesisProducer` /
 * `portedV1ThesisProducer` are live, tested producers built against that single-sided contract.
 * Retrofitting it to carry two sides would risk both. This module coexists instead: it does not import
 * from, export to, or modify `thesis-producer.ts` beyond reusing its `ThesisSide` type. Reconciling the
 * two -- retiring one, or making this the vehicle for a future NATIVE authority -- is separate work.
 *
 * ## Where directional evidence comes from, and why that does not re-violate I3
 *
 * The only quarantine-clean directional evidence available is P5's `OpportunityCandidate.orientation`.
 * I3 ("Opportunity Resolver never scores or ranks") scopes to P5's own grouping step: P5 already
 * discharged its obligation by carrying every orientation bucket forward as a sibling, un-ranked.
 * Deciding "does the LONG side have supporting evidence" from that observation is this stage's job, not
 * a re-run of P5's. The one thing that WOULD smuggle a `patterns[0]`-style selection in one stage early
 * is if this module received a single, pre-picked candidate rather than the full set P5 produced for
 * the bar -- so `ThesisBuilderInput.candidates` is the whole array, and each side searches it
 * independently for its own supporting orientation. Neither side's search is influenced by the other.
 *
 * ## "Conviction" and "rationale" without a composite score (I18)
 *
 * `conviction` is a closed categorical label -- the same shape `InstitutionalFlowStance` already uses
 * in state-interpreter.ts -- never a number that could be summed or compared across sides. `rationale`
 * is a list of named facts, the same shape `Rejected.reasons` already uses -- never weighted.
 *
 * ## Geometry is re-derived, not imported
 *
 * `momentum-scalp-strategy.ts` computes entry/stop/target from ATR and is not quarantined, but its
 * math is inlined in `buildProposal`, not exported, and copying it verbatim would import V1's tuned
 * policy constants as though they were V2.2's own. So the same shape of computation is re-proven here
 * under `thesisGeometryPolicyVersion`, a natively-owned policy (Gap 6: referenced, never copied).
 *
 * ## Candidate Dataset: type and mapping only
 *
 * No table, type, or module named "Candidate Dataset" exists anywhere in this codebase yet.
 * `CandidateDatasetEntry` and `toCandidateDatasetEntry` are the documented target shape for what a
 * rejected side would seed -- not persistence. Matches the posture `CandidateResolved` and
 * `MarketStateInterpreted` already established: a typed target, fully tested, not wired to any store.
 */

export const thesisBuilderPolicyVersion = "NATIVE_THESIS_BUILDER_POLICY_V1";
export const thesisGeometryPolicyVersion = "NATIVE_THESIS_GEOMETRY_POLICY_V1";

// Referenced, never copied (Gap 6): a new, natively-owned policy, not an import of V1's tuned numbers,
// even though the shape of the computation is the same one momentum-scalp-strategy.ts already proved.
const atrStopMultiple = 1.0;
const rewardRiskMultiple = 1.5;

/** Closed, categorical, never summed or compared across sides -- same shape as InstitutionalFlowStance. */
export type ConvictionLabel = "ORIENTATION_SUPPORTED" | "NO_ORIENTATION_SUPPORT";

export interface SideGeometry {
  readonly side: ThesisSide;
  readonly entryReference: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly conviction: ConvictionLabel;
  /** Named facts, never weighted -- same shape as Rejected.reasons. */
  readonly rationale: readonly string[];
  /** The OpportunityCandidate.candidateId that supplied this side's orientation evidence. */
  readonly supportingCandidateId: string;
}

export type SideRefusal = "NO_ORIENTATION_EVIDENCE" | "DEGENERATE_GEOMETRY";
export type SideResult = EvaluationResult<SideGeometry, SideRefusal>;

export interface DualSidedThesis {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly long: SideResult;
  readonly short: SideResult;
  readonly policyVersion: string;
}

/**
 * Stage-level refusal, kept structurally separate from SideRefusal. thesis-producer.ts's
 * ThesisRefusal already exists for "the whole bar couldn't be evaluated"; conflating a per-side
 * refusal with a stage-level one would blur "we abstained on ambiguity" with "we recorded one side as
 * unsupported", which are opposite postures.
 */
export type ThesisBuilderRefusal = "ATR_NOT_AVAILABLE_FOR_BAR";
export type ThesisBuilderResult = EvaluationResult<DualSidedThesis, ThesisBuilderRefusal>;

export class ThesisBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThesisBuilderError";
  }
}

/**
 * The P6b proof: kind: "THESIS_FORMED", matching decision-lifecycle.ts's wired vocabulary, not the
 * frozen architecture doc's illustrative "THESIS_APPROVED" -- same precedent P5 and P6a both applied.
 * Not constructed anywhere as a runtime object yet -- a documented target shape.
 */
export interface ThesisFormed {
  readonly kind: "THESIS_FORMED";
  readonly thesis: DualSidedThesis;
  readonly candidate: OpportunityCandidate;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface ThesisBuilderInput {
  /** The full set P5 produced for this bar -- never a single, pre-picked candidate. See module docstring. */
  readonly candidates: readonly OpportunityCandidate[];
  readonly context: Readonly<BaseDecisionContext>;
  readonly instrumentSymbol: string;
  readonly tickSize: number;
  /** The bar's close. Threaded as an already-resolved sibling, same posture as atrValue. */
  readonly entryReference: number;
  readonly atrValue: number | null;
}

function roundToTick(value: number, tickSize: number, direction: "down" | "up" | "nearest"): number {
  const ticks = value / tickSize;
  const rounded = direction === "down" ? Math.floor(ticks) : direction === "up" ? Math.ceil(ticks) : Math.round(ticks);
  return Number((rounded * tickSize).toFixed(10));
}

const LONG_SUPPORTING_ORIENTATIONS: ReadonlySet<OpportunityCandidate["orientation"]> = new Set(["UP", "BIDIRECTIONAL"]);
const SHORT_SUPPORTING_ORIENTATIONS: ReadonlySet<OpportunityCandidate["orientation"]> = new Set(["DOWN", "BIDIRECTIONAL"]);

function evaluateSide(input: {
  readonly side: ThesisSide;
  readonly candidates: readonly OpportunityCandidate[];
  readonly entryReference: number;
  readonly atrValue: number;
  readonly tickSize: number;
}): SideResult {
  const supporting = input.side === "LONG" ? LONG_SUPPORTING_ORIENTATIONS : SHORT_SUPPORTING_ORIENTATIONS;
  const supportingCandidate = input.candidates.find((candidate) => supporting.has(candidate.orientation));

  if (!supportingCandidate) {
    return { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] };
  }

  const stopDistance = Math.max(input.tickSize, input.atrValue * atrStopMultiple);
  const stopLoss = input.side === "LONG"
    ? roundToTick(input.entryReference - stopDistance, input.tickSize, "down")
    : roundToTick(input.entryReference + stopDistance, input.tickSize, "up");

  const stopDegenerate = stopLoss <= 0
    || (input.side === "LONG" && stopLoss >= input.entryReference)
    || (input.side === "SHORT" && stopLoss <= input.entryReference);
  if (stopDegenerate) {
    return { outcome: "REJECTED", reasons: ["DEGENERATE_GEOMETRY"] };
  }

  const risk = Math.abs(input.entryReference - stopLoss);
  const targetPrice = input.side === "LONG"
    ? roundToTick(input.entryReference + risk * rewardRiskMultiple, input.tickSize, "up")
    : roundToTick(input.entryReference - risk * rewardRiskMultiple, input.tickSize, "down");

  const targetDegenerate = targetPrice <= 0
    || (input.side === "LONG" && targetPrice <= input.entryReference)
    || (input.side === "SHORT" && targetPrice >= input.entryReference);
  if (targetDegenerate) {
    return { outcome: "REJECTED", reasons: ["DEGENERATE_GEOMETRY"] };
  }

  return approved(Object.freeze({
    side: input.side,
    entryReference: input.entryReference,
    stopLoss,
    targetPrice,
    conviction: "ORIENTATION_SUPPORTED" as const,
    rationale: Object.freeze([
      `Candidate ${supportingCandidate.candidateId} carries orientation ${supportingCandidate.orientation}, `
      + `which supports a ${input.side} side.`,
    ]),
    supportingCandidateId: supportingCandidate.candidateId,
  }));
}

/**
 * Builds a dual-sided thesis for one bar, evaluating LONG and SHORT independently.
 *
 * Total by construction: the throws below are all caller/data defects, never a business refusal --
 * this stage's only business-level gap is a missing ATR reading, which blocks both sides equally and
 * is therefore a stage-level refusal rather than two independent per-side ones.
 */
export function buildThesis(input: ThesisBuilderInput): ThesisBuilderResult {
  if (input.instrumentSymbol.trim().length === 0) {
    throw new ThesisBuilderError(
      "A thesis that cannot name its instrument cannot be joined to anything downstream.",
    );
  }
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    throw new ThesisBuilderError("tickSize must be a positive, finite number.");
  }
  if (!Number.isFinite(input.entryReference) || input.entryReference <= 0) {
    throw new ThesisBuilderError("entryReference must be a positive, finite number.");
  }
  if (Number.isNaN(input.context.decisionAt.getTime())) {
    throw new ThesisBuilderError("context.decisionAt must be a valid Date.");
  }

  if (input.atrValue === null || !Number.isFinite(input.atrValue) || input.atrValue <= 0) {
    return deferred({
      reason: "ATR_NOT_AVAILABLE_FOR_BAR",
      blockingDependency: "ATR indicator for this bar",
    });
  }

  const observedIn = input.candidates[0]?.observedIn;
  if (!observedIn) {
    throw new ThesisBuilderError(
      "A thesis needs at least one candidate to know which snapshot it was built against.",
    );
  }

  const long = evaluateSide({
    side: "LONG",
    candidates: input.candidates,
    entryReference: input.entryReference,
    atrValue: input.atrValue,
    tickSize: input.tickSize,
  });
  const short = evaluateSide({
    side: "SHORT",
    candidates: input.candidates,
    entryReference: input.entryReference,
    atrValue: input.atrValue,
    tickSize: input.tickSize,
  });

  return approved(Object.freeze({
    instrumentSymbol: input.instrumentSymbol,
    decisionAt: input.context.decisionAt,
    observedIn,
    long,
    short,
    policyVersion: thesisBuilderPolicyVersion,
  }));
}

export interface CandidateDatasetEntry {
  readonly entryId: string;
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly side: ThesisSide;
  readonly refusal: SideRefusal;
  readonly observedIn: SnapshotRef;
}

/**
 * Maps a rejected side into the Candidate Dataset's target shape. Only callable with a `NotApproved`
 * side -- an approved side has no refusal to record, and the type enforces that at the call site.
 */
export function toCandidateDatasetEntry(input: {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly side: ThesisSide;
  readonly rejected: NotApproved<SideRefusal>;
}): CandidateDatasetEntry {
  const refusal: SideRefusal = input.rejected.outcome === "REJECTED"
    ? input.rejected.reasons[0]!
    : (() => {
        throw new ThesisBuilderError(
          `Candidate Dataset entries are only defined for a REJECTED side today; got ${input.rejected.outcome}.`,
        );
      })();

  const entryId = logicalKey("candidate-dataset-entry", [
    input.instrumentSymbol,
    input.decisionAt,
    input.side,
    refusal,
    input.observedIn.snapshotId,
  ]);

  return Object.freeze({
    entryId,
    instrumentSymbol: input.instrumentSymbol,
    decisionAt: input.decisionAt,
    side: input.side,
    refusal,
    observedIn: input.observedIn,
  });
}
