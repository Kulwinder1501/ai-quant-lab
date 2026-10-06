import { describe, expect, it } from "vitest";
import {
  legacyPatternObservationHash,
  opportunityGroupingPolicyVersion,
  OpportunityResolverError,
  resolveOpportunityCandidates,
  type OpportunityCandidate,
} from "./opportunity-resolver.js";
import type { LegacyPatternObservation, ObservationOrientation } from "../application/pattern-adapter.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { logicalKey } from "../../platform/identity/identity.js";
import { beginLineage, completedStates, artifactApprovedAt } from "./decision-lineage.js";
import { assertAppendable, type DecisionLedgerEvent } from "./decision-ledger.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: decisionAt,
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const otherObservedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:26" });

function observation(overrides: Partial<LegacyPatternObservation> = {}): LegacyPatternObservation {
  return Object.freeze({
    provenance: "LEGACY_CANDLESTICK" as const,
    patternCode: "HAMMER",
    algorithmVersion: "candlestick-v1",
    orientation: "UP" as ObservationOrientation,
    detectorConfidence: 0.72,
    contextCandleIds: Object.freeze(["candle-1"]),
    details: Object.freeze({ bodyRatio: 0.31 }),
    instants,
    observedIn,
    ...overrides,
  });
}

function resolve(observations: readonly LegacyPatternObservation[], instrumentSymbol = "NIFTY50") {
  return resolveOpportunityCandidates({
    observations,
    patternCoverage: "LOADED",
    instrumentSymbol,
    decisionAt,
  });
}

function approvedCandidates(observations: readonly LegacyPatternObservation[], instrumentSymbol = "NIFTY50"): readonly OpportunityCandidate[] {
  const result = resolve(observations, instrumentSymbol);
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

describe("determinism and order-independence (I3)", () => {
  it("produces the same candidateId for the same input twice", () => {
    const observations = [observation({ patternCode: "HAMMER" }), observation({ patternCode: "DOJI" })];

    const first = approvedCandidates(observations);
    const second = approvedCandidates(observations);

    expect(first).toHaveLength(1);
    expect(first[0]!.candidateId).toBe(second[0]!.candidateId);
  });

  it("produces the same candidateId when the input observation order is permuted", () => {
    // The load-bearing I3 property: no input ordering can be read as a ranking.
    const a = observation({ patternCode: "HAMMER" });
    const b = observation({ patternCode: "DOJI" });
    const c = observation({ patternCode: "ENGULFING" });

    const forward = approvedCandidates([a, b, c]);
    const reversed = approvedCandidates([c, b, a]);

    expect(forward).toHaveLength(1);
    expect(forward[0]!.candidateId).toBe(reversed[0]!.candidateId);
  });

  it("orders candidate.members identically regardless of input order, by hash rather than input position", () => {
    const a = observation({ patternCode: "HAMMER" });
    const b = observation({ patternCode: "DOJI" });
    const c = observation({ patternCode: "ENGULFING" });

    const forward = approvedCandidates([a, b, c])[0]!;
    const reversed = approvedCandidates([c, b, a])[0]!;

    expect(forward.members.map((m) => m.patternCode)).toEqual(reversed.members.map((m) => m.patternCode));
  });

  it("produces a different candidateId when the membership set differs", () => {
    const withOne = approvedCandidates([observation({ patternCode: "HAMMER" })]);
    const withTwo = approvedCandidates([observation({ patternCode: "HAMMER" }), observation({ patternCode: "DOJI" })]);

    expect(withOne[0]!.candidateId).not.toBe(withTwo[0]!.candidateId);
  });

  it("produces a different candidateId when instrumentSymbol, decisionAt, or orientation differs", () => {
    const base = approvedCandidates([observation()], "NIFTY50")[0]!;
    const otherInstrument = approvedCandidates([observation()], "BANKNIFTY")[0]!;
    const otherOrientation = approvedCandidates([observation({ orientation: "DOWN" })])[0]!;
    const otherResult = resolveOpportunityCandidates({
      observations: [observation()],
      patternCoverage: "LOADED",
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date(decisionAt.getTime() + 60_000),
    });
    const otherDecisionAt = otherResult.outcome === "APPROVED" ? otherResult.value[0]! : undefined;

    expect(base.candidateId).not.toBe(otherInstrument.candidateId);
    expect(base.candidateId).not.toBe(otherOrientation.candidateId);
    expect(base.candidateId).not.toBe(otherDecisionAt?.candidateId);
  });
});

describe("grouping semantics", () => {
  it("groups observations into one candidate per orientation, never selecting one as primary", () => {
    const candidates = approvedCandidates([
      observation({ patternCode: "HAMMER", orientation: "UP" }),
      observation({ patternCode: "ENGULFING", orientation: "DOWN" }),
      observation({ patternCode: "DOJI", orientation: "NONE" }),
    ]);

    expect(candidates).toHaveLength(3);
    const byOrientation = new Map(candidates.map((c) => [c.orientation, c]));
    expect(byOrientation.get("UP")!.members.map((m) => m.patternCode)).toEqual(["HAMMER"]);
    expect(byOrientation.get("DOWN")!.members.map((m) => m.patternCode)).toEqual(["ENGULFING"]);
    expect(byOrientation.get("NONE")!.members.map((m) => m.patternCode)).toEqual(["DOJI"]);
  });

  it("produces one candidate when every observation shares one orientation", () => {
    const candidates = approvedCandidates([
      observation({ patternCode: "HAMMER" }),
      observation({ patternCode: "DOJI" }),
      observation({ patternCode: "ENGULFING" }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.members).toHaveLength(3);
  });

  it("produces no candidate for an orientation with zero members", () => {
    const candidates = approvedCandidates([
      observation({ orientation: "UP" }),
      observation({ orientation: "DOWN" }),
    ]);

    expect(candidates.map((c) => c.orientation).sort()).toEqual(["DOWN", "UP"]);
    expect(candidates.some((c) => c.orientation === "NONE")).toBe(false);
  });

  it("sorts the returned candidates by candidateId, so array position carries no meaning", () => {
    const candidates = approvedCandidates([
      observation({ orientation: "DOWN" }),
      observation({ orientation: "UP" }),
    ]);

    const ids = candidates.map((c) => c.candidateId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("coverage branching", () => {
  it("returns NO_ACTION when the pattern layer was computed and genuinely empty", () => {
    const result = resolveOpportunityCandidates({
      observations: [],
      patternCoverage: "LOADED",
      instrumentSymbol: "NIFTY50",
      decisionAt,
    });

    expect(result).toEqual({ outcome: "NO_ACTION", reason: "NO_PATTERNS_OBSERVED" });
  });

  it("returns DEFERRED when the pattern layer was not computed, naming the blocking dependency", () => {
    const result = resolveOpportunityCandidates({
      observations: [],
      patternCoverage: "NOT_LOADED",
      instrumentSymbol: "NIFTY50",
      decisionAt,
    });

    expect(result.outcome).toBe("DEFERRED");
    if (result.outcome === "DEFERRED") {
      expect(result.reason).toBe("PATTERN_LAYER_NOT_COMPUTED");
      expect(result.blockingDependency).toBe("candlestick pattern layer for this bar");
      expect(result.retryAt).toBeNull();
    }
  });

  it("refuses observations supplied under a not-computed layer", () => {
    expect(() => resolveOpportunityCandidates({
      observations: [observation()],
      patternCoverage: "NOT_LOADED",
      instrumentSymbol: "NIFTY50",
      decisionAt,
    })).toThrow(/refused rather than resolved/);
  });

  it("never returns REJECTED for a non-empty, coverage-consistent observation set", () => {
    const fixtures: (readonly LegacyPatternObservation[])[] = [
      [observation()],
      [observation({ orientation: "UP" }), observation({ orientation: "DOWN" })],
      [observation({ patternCode: "A" }), observation({ patternCode: "B" }), observation({ patternCode: "C" })],
    ];

    for (const observations of fixtures) {
      expect(resolve(observations).outcome).not.toBe("REJECTED");
    }
  });
});

describe("consistency across members", () => {
  it("throws when members disagree about the snapshot they were observed in", () => {
    expect(() => resolve([
      observation({ observedIn }),
      observation({ observedIn: otherObservedIn }),
    ])).toThrow(/disagree about the snapshot/);
  });
});

describe("input validation", () => {
  it("refuses a blank instrumentSymbol", () => {
    expect(() => resolve([observation()], "")).toThrow(OpportunityResolverError);
    expect(() => resolve([observation()], "   ")).toThrow(/cannot name its instrument/);
  });

  it("refuses an invalid decisionAt", () => {
    expect(() => resolveOpportunityCandidates({
      observations: [observation()],
      patternCoverage: "LOADED",
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date("not-a-date"),
    })).toThrow(/decisionAt must be a valid Date/);
  });
});

describe("structural no-rank proof", () => {
  it("invents no rank, score, primary, composite, or weight field on the candidate", () => {
    const candidates = approvedCandidates([
      observation({ orientation: "UP" }),
      observation({ orientation: "DOWN" }),
    ]);

    for (const candidate of candidates) {
      for (const key of Object.keys(candidate)) {
        expect(key).not.toMatch(/rank|score|primary|composite|weight/i);
      }
    }
  });

  it("pins the candidate's exact key set", () => {
    const [candidate] = approvedCandidates([observation()]);

    expect(Object.keys(candidate!).sort()).toEqual([
      "candidateId",
      "decisionAt",
      "groupingPolicyVersion",
      "instrumentSymbol",
      "memberObservationHashes",
      "members",
      "observedIn",
      "orientation",
    ]);
  });

  it("keeps each member's detectorConfidence individually readable; nothing composes them", () => {
    const [candidate] = approvedCandidates([
      observation({ patternCode: "A", detectorConfidence: 0.2 }),
      observation({ patternCode: "B", detectorConfidence: 0.9 }),
    ]);

    expect(candidate!.members.map((m) => m.detectorConfidence).sort()).toEqual([0.2, 0.9]);
    for (const key of Object.keys(candidate!)) {
      const value = (candidate as unknown as Record<string, unknown>)[key];
      // No field on the candidate is the sum, average, or max of the member confidences.
      expect(value).not.toBe(1.1);
      expect(value).not.toBe(0.55);
      expect(value).not.toBe(0.9);
    }
  });
});

describe("freezing", () => {
  it("freezes the candidate array, each candidate, its members array, and its memberObservationHashes", () => {
    const candidates = approvedCandidates([observation()]);

    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
    expect(Object.isFrozen(candidates[0]!.members)).toBe(true);
    expect(Object.isFrozen(candidates[0]!.memberObservationHashes)).toBe(true);
  });
});

describe("identity encoder reuse (Gap 1a)", () => {
  it("derives candidateId from the platform's pinned logicalKey/sha256CanonicalJson, not a locally invented hash", () => {
    const member = observation();
    const [candidate] = approvedCandidates([member]);

    const expected = logicalKey("opportunity-candidate", [
      "NIFTY50",
      decisionAt,
      "UP",
      observedIn.snapshotId,
      opportunityGroupingPolicyVersion,
      [legacyPatternObservationHash(member)],
    ]);

    expect(candidate!.candidateId).toBe(expected);
  });
});

describe("lineage and ledger integration", () => {
  it("seeds a decision lineage from the resolved candidate's id", () => {
    const [candidate] = approvedCandidates([observation()]);
    const lineage = beginLineage({ decisionId: "decision-1", candidateId: candidate!.candidateId });

    expect(completedStates(lineage)).toEqual(["CANDIDATE_RESOLVED"]);
    expect(artifactApprovedAt(lineage, "CANDIDATE_RESOLVED")).toBe(candidate!.candidateId);
  });

  it("the opening ledger event built from a resolved candidate passes assertAppendable", () => {
    const [candidate] = approvedCandidates([observation()]);
    const event: DecisionLedgerEvent = {
      eventId: "event-1",
      decisionId: "decision-1",
      aggregateId: "decision-1",
      aggregateVersion: 1,
      occurredAt: decisionAt,
      eventType: "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "CANDIDATE_RESOLVED",
      contextSnapshotId: candidate!.observedIn.snapshotId,
      policyVersions: { opportunityGroupingPolicyVersion },
      correlationId: "decision-1",
      causationId: null,
      payloadSnapshotId: null,
      previousEventHash: null,
      producer: { service: "autonomous-v2", version: "test", instanceId: "test" },
    };

    expect(() => assertAppendable({ event, head: null })).not.toThrow();
  });

  it("candidateId is a legal lineage artifact id", () => {
    const [candidate] = approvedCandidates([observation()]);

    expect(() => beginLineage({ decisionId: "decision-1", candidateId: candidate!.candidateId })).not.toThrow();
    expect(candidate!.candidateId).toMatch(/^[a-f0-9]{64}$/);
  });
});
