import { assertDecisionTransition, type LiveDecisionState } from "./decision-lifecycle.js";

/**
 * Upstream approval lineage: what I14 and I22 each require, and why one does not imply the other.
 *
 * **I14** — "every approved downstream object proves its upstream approvals through its type" — is a
 * *compile-time* guarantee. Brain V2.2 §2 achieves it by making each proof carry the previous stage's
 * value: an `ExecutionApproved` cannot be constructed without a `RiskDecision` in hand, so no amount
 * of care at a call site is needed.
 *
 * **I22** — "every downstream approval must carry and validate upstream lineage IDs" — is a *runtime*
 * guarantee, and it is not the same one. The type system proves a `RiskDecision` was supplied; it
 * cannot prove it is *this decision's* risk decision. Two decisions evaluated in the same tick have
 * structurally identical proofs, so a mix-up between them typechecks perfectly.
 *
 * That is the gap this file closes. Every stage records the id of the artifact it approved, and
 * advancing validates that the chain is continuous *and* that the artifact being carried is the one
 * the lineage names. A stage cannot inherit an approval it did not receive.
 *
 * The failure mode is not hypothetical in kind: the harness's opportunity resolver throws when members
 * of one opportunity disagree about their reference evidence, for the same reason -- structurally
 * valid objects that belong to different events.
 */

export type StageArtifactId = string;

export interface LineageEntry {
  readonly state: LiveDecisionState;
  /** The id of the artifact this stage approved. */
  readonly artifactId: StageArtifactId;
}

export interface DecisionLineage {
  /** Stable across every stage. The correlation id everything about this decision joins on. */
  readonly decisionId: string;
  /** Append-only, oldest first, one entry per completed stage. */
  readonly entries: readonly LineageEntry[];
}

export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new LineageError(
      `${field} must be a non-empty id of printable identifier characters; got "${value}". `
      + "A blank or decorated id makes a lineage unjoinable, which defeats the point of recording it.",
    );
  }
}

/** Opens a lineage at the first stage. There is no way to start one anywhere else. */
export function beginLineage(input: {
  readonly decisionId: string;
  readonly candidateId: StageArtifactId;
}): DecisionLineage {
  assertId(input.decisionId, "decisionId");
  assertId(input.candidateId, "candidateId");
  return Object.freeze({
    decisionId: input.decisionId,
    entries: Object.freeze([Object.freeze({
      state: "CANDIDATE_RESOLVED" as const,
      artifactId: input.candidateId,
    })]),
  });
}

/**
 * Appends a stage, validating the transition and the artifact together.
 *
 * Both checks matter and neither substitutes for the other. The transition check is I17's structural
 * one -- a stage that can be skipped is a control that can be bypassed. The artifact check is I22's --
 * the id recorded here must be the id of the thing actually approved, or the lineage becomes a
 * plausible-looking fiction that a later audit will trust.
 */
export function advanceLineage(input: {
  readonly lineage: DecisionLineage;
  readonly to: LiveDecisionState;
  readonly artifactId: StageArtifactId;
}): DecisionLineage {
  assertId(input.artifactId, "artifactId");
  const previous = input.lineage.entries[input.lineage.entries.length - 1];
  if (previous === undefined) {
    throw new LineageError("A lineage always has at least its candidate entry; this one is empty.");
  }
  assertDecisionTransition(previous.state, input.to);
  if (input.lineage.entries.some((entry) => entry.state === input.to)) {
    // Append-only and one entry per stage: a repeated stage would mean a decision was re-evaluated
    // in place, which I15 forbids for ledger history and which would make replay ambiguous.
    throw new LineageError(`${input.to} already appears in this lineage; a stage is recorded once.`);
  }
  return Object.freeze({
    decisionId: input.lineage.decisionId,
    entries: Object.freeze([
      ...input.lineage.entries,
      Object.freeze({ state: input.to, artifactId: input.artifactId }),
    ]),
  });
}

/** The artifact a given stage approved, or null when the stage has not run. */
export function artifactApprovedAt(
  lineage: DecisionLineage,
  state: LiveDecisionState,
): StageArtifactId | null {
  return lineage.entries.find((entry) => entry.state === state)?.artifactId ?? null;
}

/**
 * Asserts that a lineage belongs to the decision and the artifact a stage is about to build on.
 *
 * The check the type system cannot make. Called by a stage before it trusts an upstream proof, because
 * two decisions in the same tick produce structurally identical proofs and the compiler is satisfied
 * by either.
 */
export function assertLineageCarries(input: {
  readonly lineage: DecisionLineage;
  readonly decisionId: string;
  readonly state: LiveDecisionState;
  readonly artifactId: StageArtifactId;
}): void {
  if (input.lineage.decisionId !== input.decisionId) {
    throw new LineageError(
      `Lineage belongs to decision ${input.lineage.decisionId}, not ${input.decisionId}. Two decisions `
      + "evaluated in the same tick have structurally identical proofs, so this is the only check that "
      + "catches one inheriting the other's approval.",
    );
  }
  const recorded = artifactApprovedAt(input.lineage, input.state);
  if (recorded === null) {
    throw new LineageError(`Lineage has no ${input.state} entry, so nothing at that stage was approved.`);
  }
  if (recorded !== input.artifactId) {
    throw new LineageError(
      `Lineage records ${input.state} artifact ${recorded}, but ${input.artifactId} was supplied. `
      + "The proof is well-formed and belongs to a different decision.",
    );
  }
}

/**
 * The states a lineage has completed, in order.
 *
 * Exposed so the ledger can write `stateFrom`/`stateTo` from the lineage rather than from a caller's
 * idea of where the decision was -- the two disagreeing is how a ledger stops describing what happened.
 */
export function completedStates(lineage: DecisionLineage): readonly LiveDecisionState[] {
  return lineage.entries.map((entry) => entry.state);
}
