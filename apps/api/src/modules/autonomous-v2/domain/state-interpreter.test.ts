import { describe, expect, it } from "vitest";
import {
  interpretMarketState,
  stateInterpretationPolicyVersion,
  StateInterpreterError,
  type MarketStateInterpretation,
  type StateInterpreterInput,
} from "./state-interpreter.js";
import type { OpportunityCandidate } from "./opportunity-resolver.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { logicalKey } from "../../platform/identity/identity.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";
import { beginLineage, advanceLineage, completedStates, assertLineageCarries } from "./decision-lineage.js";
import { assertAppendable, decisionEventHash, type DecisionLedgerEvent } from "./decision-ledger.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: new Date(decisionAt.getTime() - 1),
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return Object.freeze({
    candidateId: "candidate-hash-placeholder",
    instrumentSymbol: "NIFTY50",
    decisionAt,
    orientation: "UP",
    observedIn,
    memberObservationHashes: Object.freeze(["a".repeat(64)]),
    members: Object.freeze([]),
    groupingPolicyVersion: "OPPORTUNITY_GROUPING_POLICY_V1",
    ...overrides,
  });
}

function context(overrides: Partial<BaseDecisionContext> = {}): Readonly<BaseDecisionContext> {
  return Object.freeze({
    decisionId: "decision-1",
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ stateInterpretationPolicyVersion }),
    ...overrides,
  });
}

function input(overrides: Partial<StateInterpreterInput> = {}): StateInterpreterInput {
  return {
    candidate: candidate(),
    context: context(),
    volatilityReading: { vixClose: 15, vixSma20: 12 },
    institutionalFlow: { fiiCashNetCr: 500, diiCashNetCr: 300 },
    ...overrides,
  };
}

function approvedInterpretation(overrides: Partial<StateInterpreterInput> = {}): MarketStateInterpretation {
  const result = interpretMarketState(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

describe("determinism", () => {
  it("produces the same interpretationId for the same input twice", () => {
    expect(approvedInterpretation().interpretationId).toBe(approvedInterpretation().interpretationId);
  });

  it("produces a different interpretationId when volatilityReading differs", () => {
    const a = approvedInterpretation({ volatilityReading: { vixClose: 15, vixSma20: 12 } });
    const b = approvedInterpretation({ volatilityReading: { vixClose: 10, vixSma20: 12 } });
    expect(a.interpretationId).not.toBe(b.interpretationId);
  });

  it("produces a different interpretationId when institutionalFlow differs", () => {
    const a = approvedInterpretation({ institutionalFlow: { fiiCashNetCr: 500, diiCashNetCr: 300 } });
    const b = approvedInterpretation({ institutionalFlow: { fiiCashNetCr: -500, diiCashNetCr: 300 } });
    expect(a.interpretationId).not.toBe(b.interpretationId);
  });

  it("produces a different interpretationId when instrumentSymbol or decisionAt differs", () => {
    const base = approvedInterpretation();
    const otherInstrument = approvedInterpretation({ candidate: candidate({ instrumentSymbol: "BANKNIFTY" }) });
    const otherTime = new Date(decisionAt.getTime() + 60_000);
    const otherDecisionAt = approvedInterpretation({
      candidate: candidate({ decisionAt: otherTime }),
      context: context({ decisionAt: otherTime }),
    });

    expect(base.interpretationId).not.toBe(otherInstrument.interpretationId);
    expect(base.interpretationId).not.toBe(otherDecisionAt.interpretationId);
  });
});

describe("regime derivation", () => {
  it("carries volatilityRegime null when volatilityReading is null", () => {
    expect(approvedInterpretation({ volatilityReading: null }).volatilityRegime).toBeNull();
  });

  it("derives HIGH_VOL when vixClose exceeds vixSma20", () => {
    const interpretation = approvedInterpretation({ volatilityReading: { vixClose: 15, vixSma20: 12 } });
    expect(interpretation.volatilityRegime).toEqual({ regime: "HIGH_VOL", valueRatio: 1.25 });
  });

  it("derives LOW_VOL when vixClose is at or below vixSma20 (boundary at ratio 1.0)", () => {
    const atBoundary = approvedInterpretation({ volatilityReading: { vixClose: 12, vixSma20: 12 } });
    const below = approvedInterpretation({ volatilityReading: { vixClose: 10, vixSma20: 12 } });
    expect(atBoundary.volatilityRegime).toEqual({ regime: "LOW_VOL", valueRatio: 1 });
    expect(below.volatilityRegime!.regime).toBe("LOW_VOL");
  });

  it("carries volatilityRegime null when the reading is non-finite or non-positive, without throwing", () => {
    expect(approvedInterpretation({ volatilityReading: { vixClose: Number.NaN, vixSma20: 12 } }).volatilityRegime).toBeNull();
    expect(approvedInterpretation({ volatilityReading: { vixClose: 0, vixSma20: 12 } }).volatilityRegime).toBeNull();
  });
});

describe("institutional flow stance", () => {
  it("reports UNKNOWN when both legs are null", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: null, diiCashNetCr: null } }).institutionalFlowStance).toBe("UNKNOWN");
  });

  it("reports UNKNOWN when exactly one leg is null", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: 500, diiCashNetCr: null } }).institutionalFlowStance).toBe("UNKNOWN");
  });

  it("reports BALANCED when both legs are within the flat threshold", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: 10, diiCashNetCr: -10 } }).institutionalFlowStance).toBe("BALANCED");
  });

  it("reports BOTH_ACCUMULATING when both legs are net positive", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: 500, diiCashNetCr: 300 } }).institutionalFlowStance).toBe("BOTH_ACCUMULATING");
  });

  it("reports BOTH_DISTRIBUTING when both legs are net negative", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: -500, diiCashNetCr: -300 } }).institutionalFlowStance).toBe("BOTH_DISTRIBUTING");
  });

  it("reports the two mixed cases", () => {
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: 500, diiCashNetCr: -300 } }).institutionalFlowStance)
      .toBe("FOREIGN_INFLOW_DOMESTIC_OUTFLOW");
    expect(approvedInterpretation({ institutionalFlow: { fiiCashNetCr: -500, diiCashNetCr: 300 } }).institutionalFlowStance)
      .toBe("FOREIGN_OUTFLOW_DOMESTIC_SUPPORT");
  });
});

describe("direction evidence: deferred, not fabricated", () => {
  it("pins directionEvidenceCoverage at NOT_LOADED regardless of candidate orientation or member count", () => {
    expect(approvedInterpretation({ candidate: candidate({ orientation: "DOWN" }) }).directionEvidenceCoverage).toBe("NOT_LOADED");
    expect(approvedInterpretation({ candidate: candidate({ orientation: "BIDIRECTIONAL" }) }).directionEvidenceCoverage).toBe("NOT_LOADED");
  });
});

describe("structural no-signal proof", () => {
  it("pins the interpretation's exact key set", () => {
    expect(Object.keys(approvedInterpretation()).sort()).toEqual([
      "decisionAt",
      "directionEvidenceCoverage",
      "institutionalFlowStance",
      "instrumentSymbol",
      "interpretationId",
      "interpretationPolicyVersion",
      "observedIn",
      "volatilityRegime",
    ]);
  });

  it("invents no long/short/buy/sell/bullish/bearish/rank/score/composite/weight/adjustment field", () => {
    for (const key of Object.keys(approvedInterpretation())) {
      expect(key).not.toMatch(/long|short|buy|sell|bullish|bearish|rank|score|composite|weight|adjustment/i);
    }
  });

  it("institutionalFlowStance is always one of the six declared descriptive values", () => {
    const declared = ["BOTH_ACCUMULATING", "BOTH_DISTRIBUTING", "FOREIGN_INFLOW_DOMESTIC_OUTFLOW", "FOREIGN_OUTFLOW_DOMESTIC_SUPPORT", "BALANCED", "UNKNOWN"];
    expect(declared).toContain(approvedInterpretation().institutionalFlowStance);
  });
});

describe("consistency validation", () => {
  it("throws when candidate.decisionAt and context.decisionAt disagree", () => {
    expect(() => interpretMarketState(input({ context: context({ decisionAt: new Date(decisionAt.getTime() + 60_000) }) })))
      .toThrow(/disagree/);
  });

  it("throws when candidate.observedIn does not match context.snapshotRef", () => {
    const other = snapshotRefFor({ bar: "NIFTY50@09:26" });
    expect(() => interpretMarketState(input({ context: context({ snapshotRef: other }) })))
      .toThrow(/does not match the sealed context/);
  });

  it("throws on a blank instrumentSymbol", () => {
    expect(() => interpretMarketState(input({ candidate: candidate({ instrumentSymbol: "  " }) })))
      .toThrow(StateInterpreterError);
  });

  it("throws on an invalid context.decisionAt", () => {
    expect(() => interpretMarketState(input({ context: context({ decisionAt: new Date("not-a-date") }) })))
      .toThrow(/must be a valid Date/);
  });
});

describe("never refuses", () => {
  it("returns APPROVED for every combination of present/absent volatility and flow legs", () => {
    const matrix: StateInterpreterInput[] = [
      input({ volatilityReading: null, institutionalFlow: { fiiCashNetCr: null, diiCashNetCr: null } }),
      input({ volatilityReading: null, institutionalFlow: { fiiCashNetCr: 100, diiCashNetCr: 100 } }),
      input({ volatilityReading: { vixClose: 15, vixSma20: 12 }, institutionalFlow: { fiiCashNetCr: null, diiCashNetCr: null } }),
      input({ volatilityReading: { vixClose: 15, vixSma20: 12 }, institutionalFlow: { fiiCashNetCr: 100, diiCashNetCr: -100 } }),
    ];
    for (const candidateInput of matrix) {
      expect(interpretMarketState(candidateInput).outcome).toBe("APPROVED");
    }
  });
});

describe("freezing", () => {
  it("freezes the interpretation and its nested volatilityRegime object", () => {
    const interpretation = approvedInterpretation();
    expect(Object.isFrozen(interpretation)).toBe(true);
    expect(Object.isFrozen(interpretation.volatilityRegime)).toBe(true);
  });
});

describe("identity encoder reuse", () => {
  it("derives interpretationId from the platform's pinned logicalKey, not a locally invented hash", () => {
    const interpretation = approvedInterpretation();
    const expected = logicalKey("market-state-interpretation", [
      "NIFTY50",
      decisionAt,
      observedIn.snapshotId,
      { regime: "HIGH_VOL", valueRatio: 1.25 },
      "NOT_LOADED",
      "BOTH_ACCUMULATING",
      stateInterpretationPolicyVersion,
    ]);
    expect(interpretation.interpretationId).toBe(expected);
  });
});

describe("lineage and ledger integration", () => {
  it("advances a candidate-seeded lineage to MARKET_STATE_INTERPRETED using the interpretation's id", () => {
    const interpretation = approvedInterpretation();
    const lineage = beginLineage({ decisionId: "decision-1", candidateId: "a".repeat(64) });
    const advanced = advanceLineage({ lineage, to: "MARKET_STATE_INTERPRETED", artifactId: interpretation.interpretationId });

    expect(completedStates(advanced)).toEqual(["CANDIDATE_RESOLVED", "MARKET_STATE_INTERPRETED"]);
  });

  it("a second ledger event built from the interpretation passes assertAppendable against the opening event's head", () => {
    const interpretation = approvedInterpretation();
    const openingEvent: DecisionLedgerEvent = {
      eventId: "event-1",
      decisionId: "decision-1",
      aggregateId: "decision-1",
      aggregateVersion: 1,
      occurredAt: decisionAt,
      eventType: "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "CANDIDATE_RESOLVED",
      contextSnapshotId: observedIn.snapshotId,
      policyVersions: { opportunityGroupingPolicyVersion: "OPPORTUNITY_GROUPING_POLICY_V1" },
      correlationId: "decision-1",
      causationId: null,
      payloadSnapshotId: null,
      previousEventHash: null,
      producer: { service: "autonomous-v2", version: "test", instanceId: "test" },
    };
    const nextEvent: DecisionLedgerEvent = {
      eventId: "event-2",
      decisionId: "decision-1",
      aggregateId: "decision-1",
      aggregateVersion: 2,
      occurredAt: decisionAt,
      eventType: "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "MARKET_STATE_INTERPRETED",
      contextSnapshotId: interpretation.observedIn.snapshotId,
      policyVersions: { stateInterpretationPolicyVersion },
      correlationId: "decision-1",
      causationId: "event-1",
      payloadSnapshotId: null,
      previousEventHash: decisionEventHash(openingEvent),
      producer: { service: "autonomous-v2", version: "test", instanceId: "test" },
    };

    expect(() => assertAppendable({ event: openingEvent, head: null })).not.toThrow();
    expect(() => assertAppendable({ event: nextEvent, head: openingEvent })).not.toThrow();
  });

  it("assertLineageCarries rejects an interpretation artifactId that does not match the lineage's recorded one", () => {
    const interpretation = approvedInterpretation();
    const lineage = beginLineage({ decisionId: "decision-1", candidateId: "a".repeat(64) });
    const advanced = advanceLineage({ lineage, to: "MARKET_STATE_INTERPRETED", artifactId: interpretation.interpretationId });

    expect(() => assertLineageCarries({
      lineage: advanced,
      decisionId: "decision-1",
      state: "MARKET_STATE_INTERPRETED",
      artifactId: "b".repeat(64),
    })).toThrow(/supplied/);
  });
});
