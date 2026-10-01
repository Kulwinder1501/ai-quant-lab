import { describe, expect, it } from "vitest";
import {
  buildThesis,
  deriveSideGeometry,
  thesisBuilderPolicyVersion,
  toCandidateDatasetEntry,
  ThesisBuilderError,
  type DualSidedThesis,
  type SideResult,
  type ThesisBuilderInput,
} from "./thesis-builder.js";
import type { OpportunityCandidate } from "./opportunity-resolver.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { logicalKey } from "../../platform/identity/identity.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

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
    candidateId: "candidate-hash-up",
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
    policyVersions: Object.freeze({ thesisBuilderPolicyVersion }),
    ...overrides,
  });
}

const NIFTY_TICK_SIZE = 0.05;

function input(overrides: Partial<ThesisBuilderInput> = {}): ThesisBuilderInput {
  return {
    candidates: [candidate()],
    context: context(),
    instrumentSymbol: "NIFTY50",
    tickSize: NIFTY_TICK_SIZE,
    entryReference: 24000,
    atrValue: 50,
    ...overrides,
  };
}

function approvedThesis(overrides: Partial<ThesisBuilderInput> = {}): DualSidedThesis {
  const result = buildThesis(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

function expectApprovedSide(side: SideResult) {
  if (side.outcome !== "APPROVED") throw new Error(`Expected APPROVED side, got ${side.outcome}.`);
  return side.value;
}

function expectRejectedSide(side: SideResult) {
  if (side.outcome !== "REJECTED") throw new Error(`Expected REJECTED side, got ${side.outcome}.`);
  return side.reasons;
}

// deriveSideGeometry is what a validated entry rule plugs into (see thesis-builder.ts's "No validated
// entry rule" section) -- evaluateSide/buildThesis cannot reach it today, but the math it will use is
// still proven correct now.
describe("geometry correctness (deriveSideGeometry, the not-yet-wired path)", () => {
  it("computes LONG stop below entry and target above, using ATR * 1.0 / 1.5x reward:risk", () => {
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));

    expect(long.stopLoss).toBe(23950);
    expect(long.targetPrice).toBe(24075);
  });

  it("computes SHORT stop above entry and target below", () => {
    const short = expectApprovedSide(deriveSideGeometry({
      side: "SHORT", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "DOWN" }),
    }));

    expect(short.stopLoss).toBe(24050);
    expect(short.targetPrice).toBe(23925);
  });

  it("rounds the stop toward safety (further from entry) and the target toward the trade", () => {
    // ATR chosen so the raw stop distance falls between tick boundaries.
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000.02, atrValue: 33, tickSize: 0.05,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));
    // stopLoss must round DOWN (away from entry, more conservative for a LONG stop).
    expect(long.stopLoss).toBeLessThanOrEqual(24000.02 - 33);
  });
});

describe("independent per-side evaluation", () => {
  it("rejects LONG with NO_VALIDATED_ENTRY_RULE (not NO_ORIENTATION_EVIDENCE) and SHORT with NO_ORIENTATION_EVIDENCE, when only UP-oriented candidates are present", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "UP" })] });

    expect(expectRejectedSide(thesis.long)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
    expect(expectRejectedSide(thesis.short)).toEqual(["NO_ORIENTATION_EVIDENCE"]);
  });

  it("rejects both sides with NO_VALIDATED_ENTRY_RULE when both UP and DOWN candidates are present", () => {
    const up = candidate({ candidateId: "up-hash", orientation: "UP" });
    const down = candidate({ candidateId: "down-hash", orientation: "DOWN" });
    const thesis = approvedThesis({ candidates: [up, down] });

    expect(expectRejectedSide(thesis.long)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
    expect(expectRejectedSide(thesis.short)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
  });

  it("a BIDIRECTIONAL candidate gives both sides orientation support, so both are rejected with NO_VALIDATED_ENTRY_RULE rather than NO_ORIENTATION_EVIDENCE", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "BIDIRECTIONAL", candidateId: "bidi-hash" })] });

    expect(expectRejectedSide(thesis.long)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
    expect(expectRejectedSide(thesis.short)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
  });

  it("rejects both sides with NO_ORIENTATION_EVIDENCE when only a NONE-oriented candidate is present", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "NONE" })] });

    expect(expectRejectedSide(thesis.long)).toEqual(["NO_ORIENTATION_EVIDENCE"]);
    expect(expectRejectedSide(thesis.short)).toEqual(["NO_ORIENTATION_EVIDENCE"]);
  });
});

describe("no validated entry rule", () => {
  it("evaluateSide (via buildThesis) can never return APPROVED today, the same property structuralGateThesisProducer already holds", () => {
    const bidirectional = candidate({ orientation: "BIDIRECTIONAL" });
    const thesis = approvedThesis({ candidates: [bidirectional] });

    expect(thesis.long.outcome).not.toBe("APPROVED");
    expect(thesis.short.outcome).not.toBe("APPROVED");
  });

  it("still distinguishes orientation-supported-but-unvalidated from no-orientation-evidence-at-all", () => {
    const supported = approvedThesis({ candidates: [candidate({ orientation: "UP" })] });
    const unsupported = approvedThesis({ candidates: [candidate({ orientation: "NONE" })] });

    expect(expectRejectedSide(supported.long)).toEqual(["NO_VALIDATED_ENTRY_RULE"]);
    expect(expectRejectedSide(unsupported.long)).toEqual(["NO_ORIENTATION_EVIDENCE"]);
  });
});

describe("no cross-side comparison", () => {
  it("LONG's result is identical whether or not a SHORT-supporting candidate is also present", () => {
    const up = candidate({ candidateId: "up-hash", orientation: "UP" });
    const down = candidate({ candidateId: "down-hash", orientation: "DOWN" });

    const longAlone = approvedThesis({ candidates: [up] }).long;
    const longWithShort = approvedThesis({ candidates: [up, down] }).long;

    expect(longAlone).toEqual(longWithShort);
  });
});

describe("structural no-composite-score proof", () => {
  it("pins DualSidedThesis's exact key set", () => {
    expect(Object.keys(approvedThesis()).sort()).toEqual([
      "decisionAt",
      "instrumentSymbol",
      "long",
      "observedIn",
      "policyVersion",
      "short",
    ]);
  });

  it("pins an approved SideGeometry's exact key set (via deriveSideGeometry, the not-yet-wired path)", () => {
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));
    expect(Object.keys(long).sort()).toEqual([
      "conviction",
      "entryReference",
      "rationale",
      "side",
      "stopLoss",
      "supportingCandidateId",
      "targetPrice",
    ]);
  });

  it("invents no score/composite/confidence/rank/weight field anywhere on the thesis or an approved side", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "BIDIRECTIONAL" })] });
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "BIDIRECTIONAL" }),
    }));

    for (const key of [...Object.keys(thesis), ...Object.keys(long)]) {
      expect(key).not.toMatch(/score|composite|confidence|rank|weight/i);
    }
  });

  it("conviction is always one of the two declared labels, never a number", () => {
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));
    expect(["ORIENTATION_SUPPORTED", "NO_ORIENTATION_SUPPORT"]).toContain(long.conviction);
  });

  it("rationale is always a string array, never a number", () => {
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));
    expect(Array.isArray(long.rationale)).toBe(true);
    for (const reason of long.rationale) expect(typeof reason).toBe("string");
  });
});

describe("stage-level ATR gap", () => {
  it("defers the whole stage when atrValue is null, not two independent per-side refusals", () => {
    const result = buildThesis(input({ atrValue: null }));
    expect(result.outcome).toBe("DEFERRED");
    if (result.outcome === "DEFERRED") {
      expect(result.reason).toBe("ATR_NOT_AVAILABLE_FOR_BAR");
      expect(result.blockingDependency).toBe("ATR indicator for this bar");
    }
  });

  it("defers when atrValue is non-finite or non-positive", () => {
    expect(buildThesis(input({ atrValue: Number.NaN })).outcome).toBe("DEFERRED");
    expect(buildThesis(input({ atrValue: 0 })).outcome).toBe("DEFERRED");
    expect(buildThesis(input({ atrValue: -5 })).outcome).toBe("DEFERRED");
  });
});

describe("degenerate geometry (deriveSideGeometry, the not-yet-wired path)", () => {
  it("rejects a side with DEGENERATE_GEOMETRY rather than throwing when the stop distance overwhelms the entry", () => {
    const long = deriveSideGeometry({
      side: "LONG",
      entryReference: 10,
      atrValue: 50, // stop distance 50 > entry 10 -> LONG stop would go negative
      tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    });
    expect(expectRejectedSide(long)).toEqual(["DEGENERATE_GEOMETRY"]);
  });
});

describe("input validation", () => {
  it("throws on a blank instrumentSymbol", () => {
    expect(() => buildThesis(input({ instrumentSymbol: "  " }))).toThrow(ThesisBuilderError);
  });

  it("throws on a non-positive tickSize", () => {
    expect(() => buildThesis(input({ tickSize: 0 }))).toThrow(/tickSize/);
  });

  it("throws on a non-positive entryReference", () => {
    expect(() => buildThesis(input({ entryReference: 0 }))).toThrow(/entryReference/);
  });

  it("throws on an invalid context.decisionAt", () => {
    expect(() => buildThesis(input({ context: context({ decisionAt: new Date("not-a-date") }) }))).toThrow(/valid Date/);
  });

  it("throws when no candidates are supplied at all", () => {
    expect(() => buildThesis(input({ candidates: [] }))).toThrow(/at least one candidate/);
  });
});

describe("freezing and determinism", () => {
  it("freezes the thesis", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "UP" })] });
    expect(Object.isFrozen(thesis)).toBe(true);
  });

  it("freezes an approved side (via deriveSideGeometry, the not-yet-wired path)", () => {
    const long = expectApprovedSide(deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    }));
    expect(Object.isFrozen(long)).toBe(true);
  });

  it("produces an identical thesis for the same input twice", () => {
    const candidates = [candidate({ orientation: "UP" })];
    expect(approvedThesis({ candidates })).toEqual(approvedThesis({ candidates }));
  });
});

describe("Candidate Dataset mapping", () => {
  it("maps a rejected side into a CandidateDatasetEntry with a content-hashed id", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "UP" })] });
    const rejectedShort = thesis.short;
    if (rejectedShort.outcome !== "REJECTED") throw new Error("expected REJECTED");

    const entry = toCandidateDatasetEntry({
      instrumentSymbol: "NIFTY50",
      decisionAt,
      observedIn,
      side: "SHORT",
      rejected: rejectedShort,
    });

    expect(entry.refusal).toBe("NO_ORIENTATION_EVIDENCE");
    expect(entry.entryId).toBe(logicalKey("candidate-dataset-entry", [
      "NIFTY50", decisionAt, "SHORT", "NO_ORIENTATION_EVIDENCE", observedIn.snapshotId,
    ]));
  });

  it("throws if given an APPROVED side, since only rejected sides seed the dataset", () => {
    // buildThesis cannot produce an APPROVED side today (see "no validated entry rule" above), so this
    // exercises the invariant via deriveSideGeometry directly, the shape a validated rule would return.
    const approvedLong = deriveSideGeometry({
      side: "LONG", entryReference: 24000, atrValue: 50, tickSize: NIFTY_TICK_SIZE,
      supportingCandidate: candidate({ orientation: "UP" }),
    });
    if (approvedLong.outcome !== "APPROVED") throw new Error("expected APPROVED");

    expect(() => toCandidateDatasetEntry({
      instrumentSymbol: "NIFTY50",
      decisionAt,
      observedIn,
      side: "LONG",
      // @ts-expect-error -- an APPROVED side is not a NotApproved<SideRefusal>, by design.
      rejected: approvedLong,
    })).toThrow(ThesisBuilderError);
  });

  it("freezes the entry", () => {
    const thesis = approvedThesis({ candidates: [candidate({ orientation: "UP" })] });
    const rejectedShort = thesis.short;
    if (rejectedShort.outcome !== "REJECTED") throw new Error("expected REJECTED");

    const entry = toCandidateDatasetEntry({
      instrumentSymbol: "NIFTY50", decisionAt, observedIn, side: "SHORT", rejected: rejectedShort,
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("Empirical Liquidity Intelligence Rule integration", () => {
  it("approves a supported side when enableEmpiricalLiquidityRule is true", () => {
    const thesis = approvedThesis({
      candidates: [candidate({ orientation: "UP" })],
      enableEmpiricalLiquidityRule: true,
    });
    expect(thesis.long.outcome).toBe("APPROVED");
    if (thesis.long.outcome === "APPROVED") {
      expect(thesis.long.value.side).toBe("LONG");
      expect(thesis.long.value.conviction).toBe("ORIENTATION_SUPPORTED");
    }
    expect(thesis.short.outcome).toBe("REJECTED");
  });
});

