import { sameSnapshotRef, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { logicalKey, sha256CanonicalJson } from "../../platform/identity/identity.js";
import type {
  LegacyPatternObservation,
  ObservationOrientation,
} from "../application/pattern-adapter.js";
import type { SnapshotCoverage } from "../application/market-context-adapter.js";
import type { BaseDecisionContext } from "./decision-context.js";
import {
  approved,
  deferred,
  noAction,
  type EvaluationResult,
} from "./decision-outcome.js";

/**
 * P5: the Opportunity Resolver (I3).
 *
 * ## What this replaces, and why it cannot rank to do it
 *
 * V1 has no formal opportunity resolution step. `ai-autonomous-agent.ts` reads `ctx.patterns[0]` --
 * an implicit, unstated selection with no documented ordering behind it. I3 forbids the obvious fix
 * of "select more carefully": *any* selection function, however reasoned, reintroduces exactly the
 * judgment call `scoreDirectionalSetup` already occupies, quarantined for having been measured to pick
 * bad shorts while looking confident.
 *
 * So this stage does not choose one pattern observation over another. It groups the observations a
 * sealed bar actually produced -- by `orientation`, the one dimension every legacy observation already
 * carries and the one a downstream consumer needs to interpret market state -- and carries every member
 * of a group forward together, identified by a content hash of the group itself. Nothing here is
 * summed, compared, or used to break a tie, because there is no tie to break: a candidate's identity is
 * its membership, not a winner among alternatives.
 *
 * ## Why grouping is by `orientation` and not, say, `patternCode`
 *
 * `orientation` is what a State Interpreter (P6's first half) actually needs -- a directional read on
 * the bar -- and it is a bucket label already present on every observation, not a derived judgment.
 * Grouping by `patternCode` would fragment a bar with three UP-oriented candlesticks into three
 * candidates that a downstream consumer would then have to re-merge, silently reinventing the grouping
 * this stage exists to do once, in one place, deterministically.
 *
 * ## Why an empty result is two different outcomes, not one
 *
 * `legacyPatternObservations` (P4) collapses "the pattern layer was never computed for this bar" and
 * "it was computed and genuinely found nothing" into the same empty array -- by design, since the
 * layer's own coverage flag is what tells them apart, not the array's length. This stage cannot
 * recover that distinction from `observations` alone, so `patternCoverage` is threaded in as a sibling
 * input rather than inferred, the same way `structuralGateThesisProducer` reads it directly rather than
 * guessing from `snapshot.patterns.length`.
 */

export const opportunityGroupingPolicyVersion = "OPPORTUNITY_GROUPING_POLICY_V1";

export interface OpportunityCandidate {
  /**
   * `logicalKey("opportunity-candidate", [...])` over every field below except `members` itself. A
   * hash of membership, never a rank -- see the module docstring.
   */
  readonly candidateId: string;
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  /** The one grouping dimension. A bucket label, not an ordering. */
  readonly orientation: ObservationOrientation;
  /** Shared by every member; asserted below, never assumed. */
  readonly observedIn: SnapshotRef;
  /** Sorted ascending by hash value. Carries no meaning beyond determinism -- never detection order. */
  readonly memberObservationHashes: readonly string[];
  /**
   * Same order as `memberObservationHashes`. Never input order: `members[0]` is a hash-sort artifact,
   * not "the" pattern the way `patterns[0]` was.
   */
  readonly members: readonly LegacyPatternObservation[];
  /** Referenced, never copied (Gap 6): the rule that produced this grouping, so a future rule change
   *  re-identifies rather than silently reinterpreting history. */
  readonly groupingPolicyVersion: string;
}

export type OpportunityResolutionRefusal =
  | "PATTERN_LAYER_NOT_COMPUTED"
  | "NO_PATTERNS_OBSERVED";

export type OpportunityResolutionResult =
  EvaluationResult<readonly OpportunityCandidate[], OpportunityResolutionRefusal>;

export class OpportunityResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityResolverError";
  }
}

/**
 * The P5 proof: `kind: "CANDIDATE_RESOLVED"`, matching `decision-lifecycle.ts`'s already-built
 * vocabulary. The frozen architecture doc's illustrative sample uses `kind: "CANDIDATE_APPROVED"`, but
 * that type was never implemented -- the real lifecycle module (and `decision-ledger.ts` and
 * `decision-lineage.ts` after it) already committed to "RESOLVED" instead, and deliberately: "approved"
 * implies a judgment call among alternatives, which is exactly the posture I3 forbids at this stage.
 * This type follows the code that is actually wired, not the doc's illustrative snippet.
 */
export interface CandidateResolved {
  readonly kind: "CANDIDATE_RESOLVED";
  readonly candidate: OpportunityCandidate;
  readonly context: Readonly<BaseDecisionContext>;
}

/** The exact content a member's identity is hashed from -- every field, nothing inferred. */
function legacyPatternObservationContent(observation: LegacyPatternObservation): unknown {
  return {
    provenance: observation.provenance,
    patternCode: observation.patternCode,
    algorithmVersion: observation.algorithmVersion,
    orientation: observation.orientation,
    detectorConfidence: observation.detectorConfidence,
    contextCandleIds: observation.contextCandleIds,
    details: observation.details,
    instants: {
      eventAt: observation.instants.eventAt,
      knownAt: observation.instants.knownAt,
      dataThrough: observation.instants.dataThrough,
      dataThroughConvention: observation.instants.dataThroughConvention,
      earliestExecutionAt: observation.instants.earliestExecutionAt,
      referenceAt: observation.instants.referenceAt,
    },
    observedIn: { snapshotId: observation.observedIn.snapshotId, encodingVersion: observation.observedIn.encodingVersion },
  };
}

/**
 * A member's content-addressed identity. Exported so a future Pattern Ledger (or a P6 consumer
 * checking a candidate against its own copy of an observation) can verify membership independently,
 * without re-running the resolver.
 */
export function legacyPatternObservationHash(observation: LegacyPatternObservation): string {
  return sha256CanonicalJson(legacyPatternObservationContent(observation));
}

export interface OpportunityResolverInput {
  readonly observations: readonly LegacyPatternObservation[];
  readonly patternCoverage: SnapshotCoverage;
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
}

/**
 * Groups a sealed bar's pattern observations into candidates, deterministically and without ranking.
 *
 * Total by construction: every branch below returns or throws, and the throws are all caller/data
 * defects (an unnameable instrument, an invalid instant, a coverage contradiction, or observations that
 * disagree about which bar they belong to) -- never a business refusal, because this stage has no rule
 * that refuses a well-formed, non-empty observation set. See the module docstring's third section for
 * why `REJECTED` is declared in the return type but never produced here.
 */
export function resolveOpportunityCandidates(
  input: OpportunityResolverInput,
): OpportunityResolutionResult {
  if (input.instrumentSymbol.trim().length === 0) {
    throw new OpportunityResolverError(
      "A candidate that cannot name its instrument cannot be joined to anything downstream.",
    );
  }
  if (Number.isNaN(input.decisionAt.getTime())) {
    throw new OpportunityResolverError("decisionAt must be a valid Date.");
  }

  if (input.patternCoverage === "NOT_LOADED") {
    if (input.observations.length > 0) {
      throw new OpportunityResolverError(
        `${input.observations.length} pattern observation(s) supplied but the layer is declared not `
        + "computed. Coverage is declared, never inferred from emptiness, so this contradiction is "
        + "refused rather than resolved.",
      );
    }
    return deferred({
      reason: "PATTERN_LAYER_NOT_COMPUTED",
      blockingDependency: "candlestick pattern layer for this bar",
    });
  }

  if (input.observations.length === 0) {
    // The layer ran and found nothing: a healthy quiet tick, not a rejection. See decision-outcome.ts's
    // own table on why this is NO_ACTION rather than REJECTED.
    return noAction("NO_PATTERNS_OBSERVED");
  }

  const first = input.observations[0]!;
  for (const observation of input.observations.slice(1)) {
    // `first` is a baseline for an equality check, never a selection -- the same use the scalp-harness
    // opportunity resolver makes of its own `members[0]`. This is not the quarantined `patterns[0]`.
    if (!sameSnapshotRef(observation.observedIn, first.observedIn)) {
      throw new OpportunityResolverError(
        "Observations disagree about the snapshot they were observed in: structurally valid "
        + "observations that belong to different events cannot be resolved into one candidate set.",
      );
    }
  }
  const observedIn = first.observedIn;

  const buckets = new Map<ObservationOrientation, LegacyPatternObservation[]>();
  for (const observation of input.observations) {
    const bucket = buckets.get(observation.orientation);
    if (bucket) bucket.push(observation);
    else buckets.set(observation.orientation, [observation]);
  }

  const candidates: OpportunityCandidate[] = [];
  for (const [orientation, members] of buckets) {
    const hashed = members
      .map((member) => ({ member, hash: legacyPatternObservationHash(member) }))
      .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
    const memberObservationHashes = Object.freeze(hashed.map((entry) => entry.hash));
    const sortedMembers = Object.freeze(hashed.map((entry) => entry.member));

    const candidateId = logicalKey("opportunity-candidate", [
      input.instrumentSymbol,
      input.decisionAt,
      orientation,
      observedIn.snapshotId,
      opportunityGroupingPolicyVersion,
      memberObservationHashes,
    ]);

    candidates.push(Object.freeze({
      candidateId,
      instrumentSymbol: input.instrumentSymbol,
      decisionAt: input.decisionAt,
      orientation,
      observedIn,
      memberObservationHashes,
      members: sortedMembers,
      groupingPolicyVersion: opportunityGroupingPolicyVersion,
    }));
  }

  candidates.sort((left, right) => (
    left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0
  ));

  return approved(Object.freeze(candidates));
}
