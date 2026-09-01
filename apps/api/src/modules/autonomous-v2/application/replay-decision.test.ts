import { describe, expect, it } from "vitest";
import {
  policiesChangedMidDecision,
  replayDecision,
  type DecisionHistoryReader,
  type SealedContextReader,
} from "./replay-decision.js";
import { decisionEventHash, type DecisionLedgerEvent } from "../domain/decision-ledger.js";
import { InMemorySnapshotRegistry } from "../../platform/snapshot/snapshot-registry.js";

const occurredAt = new Date("2026-08-31T09:46:00.000Z");

function opening(contextSnapshotId: string, overrides: Partial<DecisionLedgerEvent> = {}): DecisionLedgerEvent {
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

function following(head: DecisionLedgerEvent, overrides: Partial<DecisionLedgerEvent> = {}): DecisionLedgerEvent {
  return {
    ...head,
    eventId: `event-${head.aggregateVersion + 1}`,
    aggregateVersion: head.aggregateVersion + 1,
    stateFrom: head.stateTo,
    stateTo: "MARKET_STATE_INTERPRETED",
    previousEventHash: decisionEventHash(head),
    ...overrides,
  };
}

const historyOf = (events: readonly DecisionLedgerEvent[]): DecisionHistoryReader => ({
  async readAggregate() { return events; },
});

/** A registry pre-loaded with one sealed context, returning its digest. */
async function sealedContext(): Promise<{ contexts: SealedContextReader; snapshotId: string }> {
  const registry = new InMemorySnapshotRegistry();
  const ref = await registry.seal({ instrumentId: "instrument-1", bars: [1, 2, 3] });
  return { contexts: registry, snapshotId: ref.snapshotId };
}

describe("replaying a sound decision", () => {
  it("reports REPLAYABLE with the reconstructed path", async () => {
    const { contexts, snapshotId } = await sealedContext();
    const first = opening(snapshotId);
    const second = following(first);

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first, second]), contexts,
    });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(report.findings).toEqual([]);
    expect(report.path).toEqual(["CANDIDATE_RESOLVED", "MARKET_STATE_INTERPRETED"]);
    expect(report.contextsResolved).toBe(2);
    expect(report.decisionId).toBe("decision-1");
  });

  it("keeps 'still in flight' separate from 'not replayable'", async () => {
    /*
     * A decision that has not finished is entirely replayable up to where it got. Folding "not
     * finished" into "not replayable" is the conflation that made an earlier collector outage
     * invisible -- "we have not looked yet" and "it broke" must not share a value.
     */
    const { contexts, snapshotId } = await sealedContext();
    const first = opening(snapshotId);

    const inFlight = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first]), contexts,
    });
    const rejected = await replayDecision({
      aggregateId: "decision-1",
      history: historyOf([first, following(first, { stateTo: "REJECTED", eventType: "DECISION_REJECTED" })]),
      contexts,
    });

    expect(inFlight.verdict).toBe("REPLAYABLE");
    expect(inFlight.complete).toBe(false);
    expect(rejected.verdict).toBe("REPLAYABLE");
    expect(rejected.complete).toBe(true);
  });

  it("treats a fully executed decision as complete", async () => {
    // EXECUTED is the last live state; the position aggregate owns everything after it (I9).
    const { contexts, snapshotId } = await sealedContext();
    let head = opening(snapshotId);
    const events = [head];
    for (const state of ["MARKET_STATE_INTERPRETED", "THESIS_FORMED", "EDGE_ASSESSED", "RISK_APPROVED", "INSTRUMENT_SELECTED", "EXECUTED"] as const) {
      head = following(head, { stateTo: state });
      events.push(head);
    }

    const report = await replayDecision({ aggregateId: "decision-1", history: historyOf(events), contexts });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(report.complete).toBe(true);
    expect(report.eventCount).toBe(7);
  });
});

describe("replay refusals", () => {
  it("refuses an aggregate with no history at all", async () => {
    const { contexts } = await sealedContext();

    const report = await replayDecision({ aggregateId: "missing", history: historyOf([]), contexts });

    expect(report.verdict).toBe("NOT_REPLAYABLE");
    expect(report.findings).toEqual(["NO_HISTORY"]);
    expect(report.decisionId).toBeNull();
  });

  it("detects a broken hash chain", async () => {
    const { contexts, snapshotId } = await sealedContext();
    const first = opening(snapshotId);
    const second = following(first, { previousEventHash: "f".repeat(64) });

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first, second]), contexts,
    });

    expect(report.verdict).toBe("NOT_REPLAYABLE");
    expect(report.findings.some((finding) => finding.startsWith("BROKEN_CHAIN"))).toBe(true);
  });

  it("detects a context that cannot be resolved", async () => {
    /*
     * This should be unreachable in production: `decision_ledger_context_resolvable` is a foreign key
     * onto the snapshot store. If it ever fires, the interesting fact is not the missing snapshot but
     * that something reached the table without going through the constraint -- which is why removing
     * the check as redundant would discard the only signal that the guarantee stopped holding.
     */
    const { contexts } = await sealedContext();
    const orphan = opening("b".repeat(64));

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([orphan]), contexts,
    });

    expect(report.verdict).toBe("NOT_REPLAYABLE");
    expect(report.findings.some((finding) => finding.startsWith("UNRESOLVABLE_CONTEXT"))).toBe(true);
    expect(report.contextsResolved).toBe(0);
  });

  it("treats an empty context as a finding rather than a legitimate empty decision", async () => {
    // A resolver returning empty instead of throwing would make a lost context look like a decision
    // that legitimately saw nothing.
    const emptyResolver: SealedContextReader = { async resolve() { return ""; } };
    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([opening("c".repeat(64))]), contexts: emptyResolver,
    });

    expect(report.findings.some((finding) => finding.startsWith("EMPTY_CONTEXT"))).toBe(true);
  });

  it("collects every problem rather than stopping at the first", async () => {
    /*
     * A decision with a broken chain *and* an unresolvable context has two things wrong with it, and
     * being told only the first means fixing it twice. Same reason a rejection names every reason.
     */
    const { contexts } = await sealedContext();
    const first = opening("d".repeat(64));
    const second = following(first, { previousEventHash: "e".repeat(64) });

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first, second]), contexts,
    });

    expect(report.findings.length).toBeGreaterThanOrEqual(3);
    expect(report.findings.some((finding) => finding.startsWith("BROKEN_CHAIN"))).toBe(true);
    expect(report.findings.filter((finding) => finding.startsWith("UNRESOLVABLE_CONTEXT"))).toHaveLength(2);
  });

  it("detects an event with no recorded policy versions", async () => {
    // Without them a replay cannot know which rules were in force, so it cannot reproduce the decision.
    const { contexts, snapshotId } = await sealedContext();

    const report = await replayDecision({
      aggregateId: "decision-1",
      history: historyOf([opening(snapshotId, { policyVersions: {} })]),
      contexts,
    });

    expect(report.findings).toContain("NO_POLICY_VERSIONS: event-1");
  });
});

describe("policy changes mid-decision", () => {
  it("surfaces a policy that changed between stages", async () => {
    /*
     * A decision evaluated under two versions of one policy cannot be replayed to a single answer, so
     * it is a replayability hazard even when every other check passes.
     *
     * Reported separately from `findings` on purpose: it is a property of the history rather than a
     * defect in the record -- it can legitimately happen when a policy is bumped between stages -- and
     * what to do about it is a research judgement, not something this function should decide.
     */
    const { contexts, snapshotId } = await sealedContext();
    const first = opening(snapshotId);
    const second = following(first, { policyVersions: { GRID: "GRID_POLICY_V2" } });

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first, second]), contexts,
    });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(policiesChangedMidDecision(report)).toEqual(["GRID: GRID_POLICY_V1 -> GRID_POLICY_V2"]);
  });

  it("reports nothing when every stage saw the same policies", async () => {
    const { contexts, snapshotId } = await sealedContext();
    const first = opening(snapshotId);

    const report = await replayDecision({
      aggregateId: "decision-1", history: historyOf([first, following(first)]), contexts,
    });

    expect(policiesChangedMidDecision(report)).toEqual([]);
    expect(report.policyVersions).toEqual({ GRID: ["GRID_POLICY_V1"] });
  });
});
