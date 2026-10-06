import { sha256CanonicalJson } from "../../platform/identity/identity.js";
import type { LegacyPatternObservation } from "../application/pattern-adapter.js";
import type { SnapshotCoverage } from "../application/market-context-adapter.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { resolveOpportunityCandidates, type OpportunityCandidate } from "./opportunity-resolver.js";
import { interpretMarketState, type MarketStateInterpretation } from "./state-interpreter.js";
import { buildThesis, type DualSidedThesis } from "./thesis-builder.js";
import { assessEdge, type DualSidedEdgeAssessment } from "./edge-assessor.js";
import { approveRisk, type DualSidedRiskApproval } from "./risk-approver.js";
import { selectInstrument, type DualSidedInstrumentSelection } from "./instrument-policy.js";
import { simulateExecution, type DualSidedExecutionFill } from "./execution-simulator.js";
import type { BaseDecisionContext } from "./decision-context.js";
import type { Deferred, EvaluationResult } from "./decision-outcome.js";
import { beginLineage, advanceLineage, type DecisionLineage } from "./decision-lineage.js";

/**
 * The Decision Pipeline: a pure orchestrator chaining P5-P10 end to end.
 *
 * Nothing in the codebase calls `resolveOpportunityCandidates -> interpretMarketState -> buildThesis ->
 * assessEdge -> approveRisk -> selectInstrument -> simulateExecution` in sequence -- each stage is
 * standalone and fully tested, but composing them, and constructing their proof-type objects for real,
 * was never built. This module does exactly that, in the same "standalone, no live-path wiring" spirit
 * every prior stage used.
 *
 * ## Not built here: real ledger events
 *
 * `decision-ledger.ts`'s `assertAppendable` requires a `contextSnapshotId` resolvable against a real
 * snapshot store and `producer` process metadata -- genuinely infrastructure-shaped facts a pure
 * function cannot responsibly fabricate. This module produces the in-memory `DecisionLineage` (already
 * built, never yet exercised end-to-end) plus a per-stage trace; a caller with real snapshot-store and
 * ledger-repository access can build real ledger events from that. Rewiring `run-shadow-decisions.ts`
 * to call this, and persisting `CandidateDatasetEntry` rows, are separate, larger changes.
 *
 * ## Why P6a is fed `candidates[0]`, not a chosen candidate (does not reintroduce I3)
 *
 * P5 can return several candidates -- one per orientation bucket -- but `interpretMarketState` reads
 * only `candidate.instrumentSymbol`/`decisionAt`/`observedIn` from its `candidate` parameter, purely to
 * consistency-check against `context`. Every candidate P5 produced for one bar shares those three
 * fields identically (P5's own contract asserts it), so swapping in a different member of the array
 * produces a byte-identical `MarketStateInterpretation`. Unlike V1's `patterns[0]`, no business meaning
 * attaches to which one is passed -- this is a consistency-check vehicle, not a selection. `buildThesis`,
 * by contrast, is given the **whole** `candidates` array, exactly as its own contract requires.
 *
 * ## Lineage `artifactId` per stage
 *
 * Reuses a stage's own content-hash field where one exists (each `OpportunityCandidate.candidateId`,
 * `marketState.interpretationId`); otherwise `sha256CanonicalJson` of the whole approved dual-sided
 * value (`thesis`, `edge`, `risk`, `instrument`, `execution` carry no dedicated id field today). Every
 * one is already a hex digest, satisfying `decision-lineage.ts`'s `ID_PATTERN` with no new encoding.
 *
 * ## Why a decision can finish without ever opening a lineage
 *
 * `advanceLineage` only accepts a `LiveDecisionState`, and `beginLineage` needs a real candidate-set
 * artifact to open at `CANDIDATE_RESOLVED`. When P5 itself defers or has nothing to report, no such
 * artifact exists, so `lineage` is `null` -- matching `decision-ledger.ts`'s own framing that the first
 * ledger event *is* arrival at `CANDIDATE_RESOLVED` (no aggregate exists before that).
 *
 * ## Why reaching EXECUTED is not the same as anything filling
 *
 * The lifecycle *state* `EXECUTED` and the pipeline *outcome* are tracked separately. `simulateExecution`
 * always returns an `APPROVED` stage-level result (per its own contract), so the lineage always reaches
 * `EXECUTED` once it gets that far -- but if both sides' fills are themselves dead (e.g. no observed
 * quote for either), nothing was actually executed. The uniform per-side check applied after every stage
 * catches this at P10 too: both dead means the pipeline's `outcome` is `DEFERRED`/`REJECTED`, even though
 * the lineage's last entry says `EXECUTED`.
 */

export interface DecisionPipelineInput {
  readonly decisionId: string;
  readonly instrumentSymbol: string;
  readonly context: Readonly<BaseDecisionContext>;

  // P5 siblings
  readonly patternObservations: readonly LegacyPatternObservation[];
  readonly patternCoverage: SnapshotCoverage;

  // P6a siblings
  readonly volatilityReading: { readonly vixClose: number; readonly vixSma20: number } | null;
  readonly institutionalFlow: {
    readonly fiiCashNetCr: number | null;
    readonly diiCashNetCr: number | null;
  };

  // P6b siblings
  readonly tickSize: number;
  readonly entryReference: number;
  readonly atrValue: number | null;

  // P7 siblings
  readonly costBps: number;

  // P8 siblings
  readonly accountSnapshot: InstrumentRiskSnapshot<unknown>;
  readonly lotSize: number;

  // P9 siblings
  readonly optionChain: OptionChainSnapshot | null;

  // P10 siblings
  readonly executionChain: OptionChainSnapshot | null;
}

export type DecisionPipelineOutcome =
  | { readonly kind: "EXECUTED" }
  | { readonly kind: "REJECTED"; readonly reasons: readonly string[] }
  | { readonly kind: "DEFERRED"; readonly reason: string; readonly blockingDependency: string }
  | { readonly kind: "CLOSED_NO_ACTION"; readonly reason: string };

export interface DecisionPipelineStages {
  readonly candidates?: readonly OpportunityCandidate[];
  readonly marketState?: MarketStateInterpretation;
  readonly thesis?: DualSidedThesis;
  readonly edge?: DualSidedEdgeAssessment;
  readonly risk?: DualSidedRiskApproval;
  readonly instrument?: DualSidedInstrumentSelection;
  readonly execution?: DualSidedExecutionFill;
}

export interface DecisionPipelineRun {
  readonly decisionId: string;
  /** The sealed context every stage ran against -- carried so a persister can seal/reference it. */
  readonly context: Readonly<BaseDecisionContext>;
  /** Null when the decision never got an APPROVED candidate set -- no CANDIDATE_RESOLVED artifact exists. */
  readonly lineage: DecisionLineage | null;
  readonly outcome: DecisionPipelineOutcome;
  readonly stages: DecisionPipelineStages;
}

export class DecisionPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionPipelineError";
  }
}

/**
 * Classifies whether a dual-sided stage result is still alive. Returns `null` while at least one side
 * is `APPROVED`; otherwise returns the terminal outcome the pipeline should stop at -- `DEFERRED` if
 * either dead side is itself deferred (a transient gap worth retrying), else `REJECTED` with every
 * rejected side's reasons concatenated.
 */
function deadSidesOutcome<R extends string>(dual: {
  readonly long: EvaluationResult<unknown, R>;
  readonly short: EvaluationResult<unknown, R>;
}): DecisionPipelineOutcome | null {
  if (dual.long.outcome === "APPROVED" || dual.short.outcome === "APPROVED") return null;

  const sides = [dual.long, dual.short];
  const deferredSide = sides.find((side): side is Deferred<R> => side.outcome === "DEFERRED");
  if (deferredSide !== undefined) {
    return {
      kind: "DEFERRED",
      reason: deferredSide.reason,
      blockingDependency: deferredSide.blockingDependency,
    };
  }

  const reasons = sides.flatMap((side) => (side.outcome === "REJECTED" ? side.reasons : []));
  return { kind: "REJECTED", reasons };
}

/**
 * Runs a decision through P5-P10 in sequence, tracking lineage and stopping at the first terminal
 * condition. Total by construction: the throws below are all caller/data defects surfaced by the
 * individual stages this function calls, never a business refusal of this function's own.
 */
export function runDecisionPipeline(input: DecisionPipelineInput): DecisionPipelineRun {
  const stages: {
    candidates?: readonly OpportunityCandidate[];
    marketState?: MarketStateInterpretation;
    thesis?: DualSidedThesis;
    edge?: DualSidedEdgeAssessment;
    risk?: DualSidedRiskApproval;
    instrument?: DualSidedInstrumentSelection;
    execution?: DualSidedExecutionFill;
  } = {};

  // P5: Opportunity Resolver
  const opportunityResult = resolveOpportunityCandidates({
    observations: input.patternObservations,
    patternCoverage: input.patternCoverage,
    instrumentSymbol: input.instrumentSymbol,
    decisionAt: input.context.decisionAt,
  });

  if (opportunityResult.outcome === "DEFERRED") {
    return {
      decisionId: input.decisionId,
      context: input.context,
      lineage: null,
      outcome: {
        kind: "DEFERRED",
        reason: opportunityResult.reason,
        blockingDependency: opportunityResult.blockingDependency,
      },
      stages,
    };
  }
  if (opportunityResult.outcome === "NO_ACTION") {
    return {
      decisionId: input.decisionId,
      context: input.context,
      lineage: null,
      outcome: { kind: "CLOSED_NO_ACTION", reason: opportunityResult.reason },
      stages,
    };
  }
  if (opportunityResult.outcome === "REJECTED") {
    // Not produced by resolveOpportunityCandidates today; handled for robustness against a future
    // contract change rather than left to fall through silently.
    return {
      decisionId: input.decisionId,
      context: input.context,
      lineage: null,
      outcome: { kind: "REJECTED", reasons: opportunityResult.reasons },
      stages,
    };
  }

  const candidates = opportunityResult.value;
  stages.candidates = candidates;
  let lineage = beginLineage({
    decisionId: input.decisionId,
    candidateId: sha256CanonicalJson(candidates.map((candidate) => candidate.candidateId)),
  });

  // P6a: State Interpreter (always APPROVED)
  const stateInterpreterResult = interpretMarketState({
    candidate: candidates[0]!,
    context: input.context,
    volatilityReading: input.volatilityReading,
    institutionalFlow: input.institutionalFlow,
  });
  if (stateInterpreterResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(
      `interpretMarketState returned ${stateInterpreterResult.outcome}, but StateInterpreterRefusal is never.`,
    );
  }
  const marketState = stateInterpreterResult.value;
  stages.marketState = marketState;
  lineage = advanceLineage({ lineage, to: "MARKET_STATE_INTERPRETED", artifactId: marketState.interpretationId });

  // P6b: Thesis Builder -- fed the FULL candidates array, not P6a's output. See module docstring.
  const thesisResult = buildThesis({
    candidates,
    context: input.context,
    instrumentSymbol: input.instrumentSymbol,
    tickSize: input.tickSize,
    entryReference: input.entryReference,
    atrValue: input.atrValue,
  });
  if (thesisResult.outcome === "DEFERRED") {
    return {
      decisionId: input.decisionId,
      context: input.context,
      lineage,
      outcome: { kind: "DEFERRED", reason: thesisResult.reason, blockingDependency: thesisResult.blockingDependency },
      stages,
    };
  }
  if (thesisResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(`buildThesis returned unexpected outcome ${thesisResult.outcome}.`);
  }
  const thesis = thesisResult.value;
  stages.thesis = thesis;
  lineage = advanceLineage({ lineage, to: "THESIS_FORMED", artifactId: sha256CanonicalJson(thesis) });

  const thesisDead = deadSidesOutcome(thesis);
  if (thesisDead !== null) {
    return { decisionId: input.decisionId, context: input.context, lineage, outcome: thesisDead, stages };
  }

  return continuePastThesis(input, thesis, lineage, stages);
}

/**
 * P7-P10, given an already-formed thesis. Split out of `runDecisionPipeline` and exported so tests can
 * drive this half of the pipeline directly: `evaluateSide` cannot produce an APPROVED side without a
 * validated entry rule (see thesis-builder.ts's "No validated entry rule" section), so
 * `runDecisionPipeline` itself cannot reach P7 today. This keeps P7-P10's own sequencing and
 * lineage-tracking covered against a hand-built approved thesis -- the shape a validated rule will
 * actually produce once one exists -- without weakening thesis-builder's honesty to make a test pass.
 */
export function continuePastThesis(
  input: DecisionPipelineInput,
  thesis: DualSidedThesis,
  lineageIn: DecisionLineage,
  stagesIn: DecisionPipelineStages,
): DecisionPipelineRun {
  let lineage = lineageIn;
  const stages = { ...stagesIn };

  // P7: Edge Engine (always APPROVED)
  const edgeResult = assessEdge({ thesis, context: input.context, costBps: input.costBps });
  if (edgeResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(`assessEdge returned ${edgeResult.outcome}, but EdgeAssessorRefusal is never.`);
  }
  const edge = edgeResult.value;
  stages.edge = edge;
  lineage = advanceLineage({ lineage, to: "EDGE_ASSESSED", artifactId: sha256CanonicalJson(edge) });

  const edgeDead = deadSidesOutcome(edge);
  if (edgeDead !== null) {
    return { decisionId: input.decisionId, context: input.context, lineage, outcome: edgeDead, stages };
  }

  // P8: Risk (always APPROVED)
  const riskResult = approveRisk({
    edge,
    thesis,
    context: input.context,
    accountSnapshot: input.accountSnapshot,
    lotSize: input.lotSize,
  });
  if (riskResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(`approveRisk returned ${riskResult.outcome}, but RiskApproverRefusal is never.`);
  }
  const risk = riskResult.value;
  stages.risk = risk;
  lineage = advanceLineage({ lineage, to: "RISK_APPROVED", artifactId: sha256CanonicalJson(risk) });

  const riskDead = deadSidesOutcome(risk);
  if (riskDead !== null) {
    return { decisionId: input.decisionId, context: input.context, lineage, outcome: riskDead, stages };
  }

  // P9: Instrument Policy
  const instrumentResult = selectInstrument({ risk, context: input.context, optionChain: input.optionChain });
  if (instrumentResult.outcome === "DEFERRED") {
    return {
      decisionId: input.decisionId,
      context: input.context,
      lineage,
      outcome: {
        kind: "DEFERRED",
        reason: instrumentResult.reason,
        blockingDependency: instrumentResult.blockingDependency,
      },
      stages,
    };
  }
  if (instrumentResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(`selectInstrument returned unexpected outcome ${instrumentResult.outcome}.`);
  }
  const instrument = instrumentResult.value;
  stages.instrument = instrument;
  lineage = advanceLineage({ lineage, to: "INSTRUMENT_SELECTED", artifactId: sha256CanonicalJson(instrument) });

  const instrumentDead = deadSidesOutcome(instrument);
  if (instrumentDead !== null) {
    return { decisionId: input.decisionId, context: input.context, lineage, outcome: instrumentDead, stages };
  }

  // P10: Execution Simulator (always APPROVED)
  const executionResult = simulateExecution({ instrument, context: input.context, executionChain: input.executionChain });
  if (executionResult.outcome !== "APPROVED") {
    throw new DecisionPipelineError(
      `simulateExecution returned ${executionResult.outcome}, but ExecutionSimulatorRefusal is never.`,
    );
  }
  const execution = executionResult.value;
  stages.execution = execution;
  lineage = advanceLineage({ lineage, to: "EXECUTED", artifactId: sha256CanonicalJson(execution) });

  const executionDead = deadSidesOutcome(execution);
  if (executionDead !== null) {
    return { decisionId: input.decisionId, context: input.context, lineage, outcome: executionDead, stages };
  }

  return { decisionId: input.decisionId, context: input.context, lineage, outcome: { kind: "EXECUTED" }, stages };
}
