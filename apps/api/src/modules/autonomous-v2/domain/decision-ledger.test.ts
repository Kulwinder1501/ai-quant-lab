import { describe, expect, it } from "vitest";
import {
  assertAppendable,
  assertLedgerChain,
  decisionEventHash,
  LedgerAppendError,
  type DecisionLedgerEvent,
} from "./decision-ledger.js";

const occurredAt = new Date("2026-08-31T09:46:00.000Z");
const contextSnapshotId = "a".repeat(64);

function opening(overrides: Partial<DecisionLedgerEvent> = {}): DecisionLedgerEvent {
  return {
    eventId: "event-1",
    decisionId: "decision-1",
    aggregateId: "decision-1",
    aggregateVersion: 1,
    occurredAt,
    eventType: "STAGE_COMPLETED",
    schemaVersion: 1,
    stateFrom: "CANDIDATE_RESOLVED",
    stateTo: "CANDIDATE_RESOLVED",
    contextSnapshotId,
    policyVersions: { GRID: "GRID_POLICY_V1" },
    correlationId: "correlation-1",
    causationId: null,
    payloadSnapshotId: null,
    previousEventHash: null,
    producer: { service: "brain", version: "2.2.0", instanceId: "instance-1" },
    ...overrides,
  };
}

/** The next event in the chain, correctly linked to `head`. */
function following(head: DecisionLedgerEvent, overrides: Partial<DecisionLedgerEvent> = {}): DecisionLedgerEvent {
  return {
    ...opening(),
    eventId: `event-${head.aggregateVersion + 1}`,
    aggregateVersion: head.aggregateVersion + 1,
    stateFrom: head.stateTo,
    stateTo: "MARKET_STATE_INTERPRETED",
    previousEventHash: decisionEventHash(head),
    ...overrides,
  };
}

describe("opening an aggregate", () => {
  it("accepts an opening event at version 1 with no predecessor", () => {
    expect(() => assertAppendable({ event: opening(), head: null })).not.toThrow();
  });

  it("refuses a new aggregate that does not start at version 1", () => {
    /*
     * A gap is what breaks the lock-free append rule: with versions dense, a stale expectedVersion
     * always targets a taken number; with a gap, it can find its target free while the head has moved
     * on, and the update is lost silently.
     */
    expect(() => assertAppendable({ event: opening({ aggregateVersion: 2 }), head: null }))
      .toThrow(/must start at version 1/);
  });

  it("refuses an opening event that claims a predecessor", () => {
    expect(() => assertAppendable({ event: opening({ previousEventHash: "b".repeat(64) }), head: null }))
      .toThrow(/no predecessor to hash/);
  });

  it("records arrival at the first state rather than a move between two", () => {
    // Requiring a real transition would force an invented prior state, and an invented state in the
    // ledger is a record of something that did not happen.
    expect(() => assertAppendable({
      event: opening({ stateFrom: "CANDIDATE_RESOLVED", stateTo: "MARKET_STATE_INTERPRETED" }), head: null,
    })).toThrow(/stateFrom equal to stateTo/);
  });
});

describe("appending to an aggregate", () => {
  const head = opening();

  it("accepts a correctly linked next event", () => {
    expect(() => assertAppendable({ event: following(head), head })).not.toThrow();
  });

  it("requires the version to be exactly one greater", () => {
    // Not merely unused: density is what makes expectedVersion sufficient without a lock.
    expect(() => assertAppendable({ event: following(head, { aggregateVersion: 3 }), head }))
      .toThrow(/exactly one greater/);
    expect(() => assertAppendable({ event: following(head, { aggregateVersion: 1 }), head }))
      .toThrow(/exactly one greater/);
  });

  it("detects a head that was edited, or an event built against another history", () => {
    /*
     * The hash chain's purpose. It does not make tampering impossible -- nothing in-process can -- it
     * makes a silent edit unavailable, which is what I15 protects.
     */
    expect(() => assertAppendable({
      event: following(head, { previousEventHash: decisionEventHash(opening({ eventId: "elsewhere" })) }),
      head,
    })).toThrow(/does not match the head's hash/);
  });

  it("covers previousEventHash in the event's own hash, so the chain is a chain", () => {
    /*
     * If the hash excluded this field, an attacker could relink an event to a different predecessor
     * without changing its hash, and every later event would still verify.
     */
    const linked = following(head);
    const relinked = { ...linked, previousEventHash: "c".repeat(64) };

    expect(decisionEventHash(relinked)).not.toBe(decisionEventHash(linked));
  });

  it("requires stateFrom to continue from the head", () => {
    expect(() => assertAppendable({
      event: following(head, { stateFrom: "EDGE_ASSESSED", stateTo: "RISK_APPROVED" }), head,
    })).toThrow(/does not continue from the head's stateTo/);
  });

  it("defers legality to the transition table rather than restating it", () => {
    // So a skipped stage stays impossible here too (I17), and one rule cannot drift from the other.
    expect(() => assertAppendable({
      event: following(head, { stateTo: "RISK_APPROVED" }), head,
    })).toThrow(/skips MARKET_STATE_INTERPRETED/);
  });

  it("refuses an aggregateId that does not match the head", () => {
    expect(() => assertAppendable({ event: following(head, { aggregateId: "decision-2" }), head }))
      .toThrow(/does not match the head's/);
  });

  it("keeps eventType and the transition in agreement", () => {
    /*
     * Two vocabularies that must agree, and this is the only place that can check it. A terminal
     * transition labelled STAGE_COMPLETED would make "how many decisions were rejected" unanswerable
     * from eventType alone.
     */
    expect(() => assertAppendable({
      event: following(head, { stateTo: "REJECTED", eventType: "STAGE_COMPLETED" }), head,
    })).toThrow(/disagrees with the transition to REJECTED, which is DECISION_REJECTED/);

    expect(() => assertAppendable({
      event: following(head, { stateTo: "REJECTED", eventType: "DECISION_REJECTED" }), head,
    })).not.toThrow();
  });

  it("refuses an event whose context cannot be resolved", () => {
    // An event that cannot resolve its sealed context is an unreplayable record of a decision (I20).
    expect(() => assertAppendable({ event: following(head, { contextSnapshotId: "not-a-digest" }), head }))
      .toThrow(/unreplayable record/);
  });

  it("refuses an event with no policy versions", () => {
    expect(() => assertAppendable({ event: following(head, { policyVersions: {} }), head }))
      .toThrow(/policy versions in force/);
  });

  it("refuses a non-integer version and an invalid clock", () => {
    expect(() => assertAppendable({ event: following(head, { aggregateVersion: 2.5 }), head }))
      .toThrow(LedgerAppendError);
    expect(() => assertAppendable({ event: following(head, { occurredAt: new Date("nope") }), head }))
      .toThrow(/valid Date/);
  });
});

describe("verifying a whole chain for replay", () => {
  it("accepts a genuine history", () => {
    const first = opening();
    const second = following(first);
    const third = following(second, { stateTo: "THESIS_FORMED" });

    expect(() => assertLedgerChain([first, second, third])).not.toThrow();
  });

  it("rejects a history that is pairwise valid but starts at the wrong version", () => {
    /*
     * Checking pairs independently would pass this: every link is consistent with its neighbour, and
     * only the whole-chain check notices the aggregate never had a version 1.
     */
    const second = opening({ aggregateVersion: 2 });
    const third = following(second);

    expect(() => assertLedgerChain([second, third])).toThrow(/must start at version 1/);
  });

  it("rejects an edit anywhere in the chain, at the first event after it", () => {
    const first = opening();
    const second = following(first);
    const tampered = { ...first, occurredAt: new Date("2020-01-01T00:00:00.000Z") };

    // `second` still links to the original hash, so the edit surfaces immediately rather than at the head.
    expect(() => assertLedgerChain([tampered, second])).toThrow(/does not match the head's hash/);
  });

  it("refuses an empty aggregate", () => {
    expect(() => assertLedgerChain([])).toThrow(/at least its opening event/);
  });
});
