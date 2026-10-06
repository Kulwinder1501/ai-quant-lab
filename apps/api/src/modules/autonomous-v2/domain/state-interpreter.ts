import { sameSnapshotRef, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { logicalKey } from "../../platform/identity/identity.js";
import { deriveVolatilityRegime, type RegimeContext } from "../../strategy-engine/domain/regime.js";
import { classifyStance, type InstitutionalFlowStance } from "../../market-data/domain/institutional-flow-summary.js";
import type { OpportunityCandidate } from "./opportunity-resolver.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { approved, type EvaluationResult } from "./decision-outcome.js";

/**
 * The State Interpreter (first half of P6): the stage between P5's Opportunity Resolver and the
 * Thesis Builder.
 *
 * ## What this is, and what it deliberately is not
 *
 * Per the pipeline diagram, this stage produces `MarketStateInterpretation` -- "Regime · Direction
 * evidence · Bias -- NO trade signal, observation only." It answers "what is the market doing", never
 * "what should be done about it". A thesis is the next stage's job.
 *
 * ## Why two candidate sources were left out, even though nothing quarantines their import path
 *
 * Three non-quarantined sources of "direction evidence" exist in this codebase:
 *
 * - `regime.ts::deriveVolatilityRegime` -- a pure function returning a volatility regime or `null`.
 *   An observation, by construction: it names a state, not an action.
 * - `institutional-flow-summary.ts::classifyStance` -- explicitly documented as descriptive rather
 *   than directional, in contrast to `institutionalFlowBias` (which lives inside the quarantined
 *   `ai-autonomous-agent.ts` and stays there). Also an observation.
 * - `smc-confluence.ts::measureSmcConfluence` -- importable (not on `QUARANTINED_PATHS`, no forbidden
 *   text), but its own return type documents `adjustment` as "confidence points for the autonomous
 *   scorer." That is a trade-signal shape wearing an observation's name. Reusing it here would satisfy
 *   the letter of the quarantine while violating "NO trade signal" in substance, so it is not imported.
 * - Driver-tape breadth (`driver-tape.ts`) is deferred for a different reason: it needs a DB-backed
 *   load not derivable from a sealed `MarketSnapshot`, and `driverTapeBias()` itself requires a stated
 *   side and returns a scored adjustment -- one stage too early for something that carries no side yet.
 *
 * So `directionEvidenceCoverage` is fixed at `"NOT_LOADED"` this increment -- the same "declare the
 * slot, mark it not populated" convention `MarketSnapshot.higherTimeframeCoverage` already uses, rather
 * than silently omitting what the diagram names or fabricating content to fill it.
 *
 * ## Why this stage never refuses
 *
 * P5's `DEFERRED`/`NO_ACTION` split existed because its output is a *collection* that can legitimately
 * be empty for two distinguishable reasons (layer not computed vs. layer computed and empty).
 * `MarketStateInterpretation` is never a collection and is never itself absent -- only its
 * sub-observations can be unknown, and unknown already has a first-class representation (`null` /
 * `"UNKNOWN"`) inside an approved value. `StateInterpreterRefusal = never` makes this a checked fact
 * rather than a convention that could quietly stop holding.
 */

export const stateInterpretationPolicyVersion = "STATE_INTERPRETATION_POLICY_V1";

export interface MarketStateInterpretation {
  /** logicalKey over every field below. Content-addressed, like OpportunityCandidate.candidateId. */
  readonly interpretationId: string;
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  /** Must equal the paired candidate's observedIn and the sealed context's snapshotRef. */
  readonly observedIn: SnapshotRef;
  /** "Regime". null means unknown -- deriveVolatilityRegime's own contract, never defaulted here. */
  readonly volatilityRegime: RegimeContext | null;
  /** "Direction evidence", deferred this increment. See module docstring. */
  readonly directionEvidenceCoverage: "NOT_LOADED";
  /** "Bias" -- descriptive only, via classifyStance. Never institutionalFlowBias. */
  readonly institutionalFlowStance: InstitutionalFlowStance;
  readonly interpretationPolicyVersion: string;
}

/**
 * Uninhabited: this stage never legitimately refuses. Kept in the return type for uniformity with
 * every other stage's four-outcome discipline, so a caller narrowing on `outcome` needs no special
 * case for this stage versus any other.
 */
export type StateInterpreterRefusal = never;

export type StateInterpreterResult = EvaluationResult<MarketStateInterpretation, StateInterpreterRefusal>;

export class StateInterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateInterpreterError";
  }
}

/**
 * The P6a proof: `kind: "MARKET_STATE_INTERPRETED"`, matching `decision-lifecycle.ts`'s wired
 * vocabulary, not the frozen architecture doc's illustrative `"MARKET_STATE_APPROVED"`. Same reasoning
 * P5 applied for `CandidateResolved` over the doc's `CandidateApproved` -- stronger here, since
 * `"MARKET_STATE_APPROVED"` is not even a member of `DecisionState` and could not type-check against
 * the real lifecycle/ledger/lineage machinery at all.
 *
 * Not constructed anywhere as a runtime object yet -- a documented target shape, same posture as
 * `CandidateResolved` in opportunity-resolver.ts.
 */
export interface MarketStateInterpreted {
  readonly kind: "MARKET_STATE_INTERPRETED";
  readonly candidate: OpportunityCandidate;
  readonly marketState: MarketStateInterpretation;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface StateInterpreterInput {
  readonly candidate: OpportunityCandidate;
  readonly context: Readonly<BaseDecisionContext>;
  /** null when the volatility layer has no reading for this bar. Never defaulted to a fake regime. */
  readonly volatilityReading: { readonly vixClose: number; readonly vixSma20: number } | null;
  /** Null legs mean the print is absent; classifyStance already answers "UNKNOWN" for that. */
  readonly institutionalFlow: {
    readonly fiiCashNetCr: number | null;
    readonly diiCashNetCr: number | null;
  };
}

/**
 * Interprets market state for a resolved candidate, deterministically and without producing a trade
 * signal.
 *
 * Total by construction: every branch below returns or throws, and the throws are all caller/data
 * defects -- an unnameable instrument, an invalid instant, or the candidate and context disagreeing
 * about which decision they belong to -- never a business refusal, because this stage has no rule that
 * refuses a well-formed pairing. See the module docstring's third section for why `StateInterpreterRefusal`
 * is `never`.
 */
export function interpretMarketState(input: StateInterpreterInput): StateInterpreterResult {
  const { candidate, context } = input;

  if (candidate.instrumentSymbol.trim().length === 0) {
    throw new StateInterpreterError(
      "A candidate that cannot name its instrument cannot be paired with a market-state observation.",
    );
  }
  if (Number.isNaN(context.decisionAt.getTime())) {
    throw new StateInterpreterError("context.decisionAt must be a valid Date.");
  }
  if (candidate.decisionAt.getTime() !== context.decisionAt.getTime()) {
    throw new StateInterpreterError(
      "candidate.decisionAt and context.decisionAt disagree: a market-state read for a different "
      + "instant than the candidate it is paired with would silently mix two decisions (I22).",
    );
  }
  if (!sameSnapshotRef(candidate.observedIn, context.snapshotRef)) {
    throw new StateInterpreterError(
      "candidate.observedIn does not match the sealed context's snapshotRef. Interpreting market state "
      + "against a different snapshot than the candidate was resolved against would let a newer or "
      + "older snapshot leak into a sealed decision (I26).",
    );
  }

  const volatilityRegime = input.volatilityReading === null
    ? null
    : deriveVolatilityRegime(input.volatilityReading.vixClose, input.volatilityReading.vixSma20);

  const institutionalFlowStance = classifyStance(
    input.institutionalFlow.fiiCashNetCr,
    input.institutionalFlow.diiCashNetCr,
  );

  const interpretationId = logicalKey("market-state-interpretation", [
    candidate.instrumentSymbol,
    context.decisionAt,
    candidate.observedIn.snapshotId,
    volatilityRegime,
    "NOT_LOADED",
    institutionalFlowStance,
    stateInterpretationPolicyVersion,
  ]);

  return approved(Object.freeze({
    interpretationId,
    instrumentSymbol: candidate.instrumentSymbol,
    decisionAt: context.decisionAt,
    observedIn: candidate.observedIn,
    volatilityRegime: volatilityRegime === null ? null : Object.freeze({ ...volatilityRegime }),
    directionEvidenceCoverage: "NOT_LOADED" as const,
    institutionalFlowStance,
    interpretationPolicyVersion: stateInterpretationPolicyVersion,
  }));
}
