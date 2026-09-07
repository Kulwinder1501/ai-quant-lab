import { sha256CanonicalJson } from "../../platform/identity/identity.js";
import { assertDecisionTransition, type DecisionState } from "./decision-lifecycle.js";

/**
 * The append-only decision ledger: the record everything else is reconstructed from (I13, I15).
 *
 * ## `aggregateVersion` and `sequence` are different numbers
 *
 * Brain V2.2 §3 lists both and does not say how they differ, so it is written down here.
 *
 * - `aggregateVersion` is **per decision**, dense from 1. It is what optimistic concurrency compares
 *   against, and what makes a lost update impossible: see `expectedVersion` below.
 * - `sequence` is the **global** append order across every decision, assigned by persistence. It
 *   answers "what happened next in the system", which per-aggregate versions cannot -- two decisions
 *   both at version 3 say nothing about which was written first.
 *
 * Conflating them would mean either a global counter serialising unrelated decisions, or a
 * per-decision counter unable to order the system's history. Both are wrong in ways that only show up
 * under load or during an audit.
 *
 * ## Why `expectedVersion` needs no lock
 *
 * The append rule is: write at `expectedVersion + 1`, and let a UNIQUE constraint on
 * `(aggregateId, aggregateVersion)` decide. Two concurrent writers at the same expected version both
 * target the same number and exactly one insert survives -- atomically, by the constraint, with no
 * read-then-write window to lose an update in.
 *
 * This is a *different* mechanism from the paper-trade capacity gate, which locks the account row
 * `FOR UPDATE` because it must count rows before deciding. Here there is nothing to count: the
 * version being free *is* the condition, so the insert is the check. Stating the contrast because
 * reaching for the familiar lock would add contention for no guarantee.
 *
 * Versions staying dense is what makes this sufficient. If a gap could exist, an append with a stale
 * `expectedVersion` could find its target free while the head had moved on. Every append going
 * through this rule is what keeps them dense, so `assertAppendable` refuses a non-contiguous version
 * rather than trusting it.
 *
 * ## The hash chain makes tampering evident, not impossible
 *
 * `previousEventHash` links each event to its predecessor within the aggregate, so altering a
 * historical event invalidates every event after it. Combined with the append-only trigger, an edit
 * has to break either the database or the chain. This does not prevent a determined rewrite -- nothing
 * in-process can -- it makes a silent one unavailable, which is what I15 is actually protecting.
 */

/**
 * What kind of thing happened, kept deliberately small.
 *
 * The state pair carries which stage; duplicating the state names as event names would create two
 * vocabularies that must agree, and one of them would eventually not.
 */
export const DECISION_EVENT_TYPES = [
  "STAGE_COMPLETED",
  "DECISION_REJECTED",
  "DECISION_DEFERRED",
  "DECISION_CLOSED_NO_ACTION",
] as const;

export type DecisionEventType = (typeof DECISION_EVENT_TYPES)[number];

export interface EventProducer {
  readonly service: string;
  readonly version: string;
  /** Which process wrote it. The field that makes a duplicate-writer incident diagnosable. */
  readonly instanceId: string;
}

export interface DecisionLedgerEvent {
  readonly eventId: string;
  readonly decisionId: string;
  /** The decision aggregate. Equal to `decisionId` today, named separately per §3. */
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: Date;
  readonly eventType: DecisionEventType;
  readonly schemaVersion: number;
  readonly stateFrom: DecisionState;
  readonly stateTo: DecisionState;
  /** The sealed context this transition was decided against. */
  readonly contextSnapshotId: string;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly correlationId: string;
  /** The event that caused this one, where there is one. */
  readonly causationId: string | null;
  /** Payload lives in the snapshot store; the ledger carries its address, not its bytes. */
  readonly payloadSnapshotId: string | null;
  /** Null only for the first event of an aggregate. */
  readonly previousEventHash: string | null;
  readonly producer: EventProducer;
}

export class LedgerAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAppendError";
  }
}

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * The content hash of an event, excluding nothing.
 *
 * Every field is covered, including `previousEventHash`, which is what makes the chain a chain: an
 * edit to any earlier event changes its hash, which invalidates the `previousEventHash` of the next,
 * and so on to the head. Excluding a field "because it is metadata" would leave a place to hide an
 * edit.
 */
export function decisionEventHash(event: DecisionLedgerEvent): string {
  return sha256CanonicalJson(event);
}

/**
 * Validates an event against its predecessor before it reaches persistence.
 *
 * Persistence enforces uniqueness and atomicity (I23, I24); this enforces the things a constraint
 * cannot express -- that the transition is legal, that the chain is continuous, and that the version
 * is the next one rather than merely an unused one.
 */
export function assertAppendable(input: {
  readonly event: DecisionLedgerEvent;
  /** The current head of this aggregate, or null when the aggregate is new. */
  readonly head: DecisionLedgerEvent | null;
}): void {
  const { event, head } = input;

  if (!Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1) {
    throw new LedgerAppendError(`aggregateVersion must be a positive integer; got ${event.aggregateVersion}.`);
  }
  if (Number.isNaN(event.occurredAt.getTime())) {
    throw new LedgerAppendError("occurredAt must be a valid Date.");
  }
  if (!HEX64.test(event.contextSnapshotId)) {
    throw new LedgerAppendError(
      "contextSnapshotId must be a snapshot digest: an event whose context cannot be resolved is an "
      + "unreplayable record of a decision (I20).",
    );
  }
  if (Object.keys(event.policyVersions).length === 0) {
    throw new LedgerAppendError("An event must record the policy versions in force, or a replay cannot reproduce it.");
  }

  if (head === null) {
    if (event.aggregateVersion !== 1) {
      throw new LedgerAppendError(
        `A new aggregate must start at version 1; got ${event.aggregateVersion}. Starting elsewhere `
        + "leaves a gap, and a gap lets a stale expectedVersion find its target free while the head has moved on.",
      );
    }
    if (event.previousEventHash !== null) {
      throw new LedgerAppendError("The first event of an aggregate has no predecessor to hash.");
    }
    if (event.stateFrom !== "CANDIDATE_RESOLVED" || event.stateTo !== "CANDIDATE_RESOLVED") {
      /*
       * The opening event records arrival at the first state rather than a move between two. Requiring
       * a real transition would force an invented prior state, and an invented state in the ledger is
       * a record of something that did not happen.
       */
      throw new LedgerAppendError(
        "The first event must record arrival at CANDIDATE_RESOLVED, with stateFrom equal to stateTo.",
      );
    }
    return;
  }

  if (event.aggregateId !== head.aggregateId) {
    throw new LedgerAppendError(`Event aggregateId ${event.aggregateId} does not match the head's ${head.aggregateId}.`);
  }
  if (event.aggregateVersion !== head.aggregateVersion + 1) {
    throw new LedgerAppendError(
      `aggregateVersion must be exactly one greater than the head (${head.aggregateVersion}); got `
      + `${event.aggregateVersion}. Dense versions are what make expectedVersion sufficient without a lock.`,
    );
  }
  if (event.previousEventHash !== decisionEventHash(head)) {
    throw new LedgerAppendError(
      "previousEventHash does not match the head's hash. Either the head was edited or this event was "
      + "built against a different history; both make the chain a record of something that did not happen.",
    );
  }
  if (event.stateFrom !== head.stateTo) {
    throw new LedgerAppendError(
      `stateFrom ${event.stateFrom} does not continue from the head's stateTo ${head.stateTo}.`,
    );
  }
  // The transition table owns legality, so a stage that can be skipped stays impossible here too (I17).
  assertDecisionTransition(event.stateFrom, event.stateTo);

  const expectedType: DecisionEventType = event.stateTo === "REJECTED"
    ? "DECISION_REJECTED"
    : event.stateTo === "DEFERRED"
      ? "DECISION_DEFERRED"
      : event.stateTo === "CLOSED_NO_ACTION"
        ? "DECISION_CLOSED_NO_ACTION"
        : "STAGE_COMPLETED";
  if (event.eventType !== expectedType) {
    // The two vocabularies must agree, and this is the one place that can check it.
    throw new LedgerAppendError(
      `eventType ${event.eventType} disagrees with the transition to ${event.stateTo}, which is ${expectedType}.`,
    );
  }
}

/**
 * Verifies a whole aggregate's chain, for replay.
 *
 * Replay reconstructs a decision from these events, so a chain that was never valid cannot be a
 * faithful reconstruction of one that happened. Checking the whole chain also catches a history that
 * is pairwise valid but starts at the wrong version.
 */
export function assertLedgerChain(events: readonly DecisionLedgerEvent[]): void {
  if (events.length === 0) throw new LedgerAppendError("An aggregate has at least its opening event.");
  let head: DecisionLedgerEvent | null = null;
  for (const event of events) {
    assertAppendable({ event, head });
    head = event;
  }
}
