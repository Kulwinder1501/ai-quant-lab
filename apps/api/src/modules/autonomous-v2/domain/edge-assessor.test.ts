import { describe, expect, it } from "vitest";
import {
  assessEdge,
  edgeAssessmentPolicyVersion,
  EdgeAssessorError,
  type DualSidedEdgeAssessment,
  type EdgeAssessmentInput,
  type SideEdgeResult,
} from "./edge-assessor.js";
import type { DualSidedThesis, SideResult } from "./thesis-builder.js";
import type { BaseDecisionContext } from "./decision-context.js";
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

function approvedSide(overrides: { entryReference?: number; stopLoss?: number; targetPrice?: number; side?: "LONG" | "SHORT" } = {}): SideResult {
  return {
    outcome: "APPROVED",
    value: {
      side: overrides.side ?? "LONG",
      entryReference: overrides.entryReference ?? 24000,
      stopLoss: overrides.stopLoss ?? 23950,
      targetPrice: overrides.targetPrice ?? 24075,
      conviction: "ORIENTATION_SUPPORTED",
      rationale: ["fixture"],
      supportingCandidateId: "candidate-hash",
    },
  };
}

function rejectedSide(): SideResult {
  return { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] };
}

function thesis(overrides: { long?: SideResult; short?: SideResult } = {}): DualSidedThesis {
  return Object.freeze({
    instrumentSymbol: "NIFTY50",
    decisionAt,
    observedIn,
    long: overrides.long ?? approvedSide({ side: "LONG" }),
    short: overrides.short ?? rejectedSide(),
    policyVersion: "NATIVE_THESIS_BUILDER_POLICY_V1",
  });
}

function context(): Readonly<BaseDecisionContext> {
  return Object.freeze({
    decisionId: "decision-1",
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ edgeAssessmentPolicyVersion }),
  });
}

function input(overrides: Partial<EdgeAssessmentInput> = {}): EdgeAssessmentInput {
  return {
    thesis: thesis(),
    context: context(),
    costBps: 5,
    ...overrides,
  };
}

function approvedAssessment(overrides: Partial<EdgeAssessmentInput> = {}): DualSidedEdgeAssessment {
  const result = assessEdge(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

function expectApprovedSide(side: SideEdgeResult) {
  if (side.outcome !== "APPROVED") throw new Error(`Expected APPROVED side, got ${side.outcome}.`);
  return side.value;
}

function expectRejectedSide(side: SideEdgeResult) {
  if (side.outcome !== "REJECTED") throw new Error(`Expected REJECTED side, got ${side.outcome}.`);
  return side.reasons;
}

describe("formula correctness", () => {
  it("computes the exact frictionless and cost-adjusted breakeven hit rates for a known geometry", () => {
    // entry 24000, stop 23950 -> riskPerUnit 50; target 24075 -> rewardPerUnit 75 -> RR 1.5.
    const assessment = approvedAssessment({
      thesis: thesis({ long: approvedSide({ entryReference: 24000, stopLoss: 23950, targetPrice: 24075 }) }),
      costBps: 5,
    });
    const long = expectApprovedSide(assessment.long);

    expect(long.baselineEdge.rewardRiskMultiple).toBeCloseTo(1.5, 10);
    expect(long.baselineEdge.frictionlessBreakEvenHitRate).toBeCloseTo(1 / 2.5, 10); // 0.4
    // roundTripCostR = 2 * (5/10000) * 24000 / 50 = 0.48
    expect(long.baselineEdge.roundTripCostR).toBeCloseTo(0.48, 10);
    // costAdjusted = (1 + 0.48) / (1 + 1.5) = 1.48 / 2.5 = 0.592
    expect(long.baselineEdge.costAdjustedBreakEvenHitRate).toBeCloseTo(0.592, 10);
  });

  it("makes the cost-adjusted rate exactly equal the frictionless one when costBps is 0", () => {
    const assessment = approvedAssessment({ costBps: 0 });
    const long = expectApprovedSide(assessment.long);
    expect(long.baselineEdge.costAdjustedBreakEvenHitRate).toBeCloseTo(long.baselineEdge.frictionlessBreakEvenHitRate, 12);
    expect(long.baselineEdge.roundTripCostR).toBe(0);
  });
});

describe("independent per-side evaluation", () => {
  it("assesses LONG and rejects SHORT when only the thesis's LONG side was approved", () => {
    const assessment = approvedAssessment({
      thesis: thesis({ long: approvedSide({ side: "LONG" }), short: rejectedSide() }),
    });
    expect(assessment.long.outcome).toBe("APPROVED");
    expect(expectRejectedSide(assessment.short)).toEqual(["NO_APPROVED_THESIS_FOR_SIDE"]);
  });

  it("assesses both sides independently when both were approved", () => {
    const assessment = approvedAssessment({
      thesis: thesis({
        long: approvedSide({ side: "LONG", entryReference: 24000, stopLoss: 23950, targetPrice: 24075 }),
        short: approvedSide({ side: "SHORT", entryReference: 24000, stopLoss: 24050, targetPrice: 23925 }),
      }),
    });
    const long = expectApprovedSide(assessment.long);
    const short = expectApprovedSide(assessment.short);
    expect(long.side).toBe("LONG");
    expect(short.side).toBe("SHORT");
    // Symmetric geometry -> identical baseline numbers.
    expect(long.baselineEdge.rewardRiskMultiple).toBeCloseTo(short.baselineEdge.rewardRiskMultiple, 10);
  });
});

describe("never refuses at the stage level", () => {
  it("still yields an APPROVED DualSidedEdgeAssessment when both thesis sides were rejected", () => {
    const result = assessEdge(input({ thesis: thesis({ long: rejectedSide(), short: rejectedSide() }) }));
    expect(result.outcome).toBe("APPROVED");
    if (result.outcome === "APPROVED") {
      expect(result.value.long.outcome).toBe("REJECTED");
      expect(result.value.short.outcome).toBe("REJECTED");
    }
  });
});

describe("ML slot declared", () => {
  it("mlEdge is always exactly null on every approved side", () => {
    const assessment = approvedAssessment({
      thesis: thesis({ long: approvedSide({ side: "LONG" }), short: approvedSide({ side: "SHORT" }) }),
    });
    expect(expectApprovedSide(assessment.long).mlEdge).toBeNull();
    expect(expectApprovedSide(assessment.short).mlEdge).toBeNull();
  });
});

describe("structural no-composite-score proof", () => {
  it("pins DualSidedEdgeAssessment's exact key set", () => {
    expect(Object.keys(approvedAssessment()).sort()).toEqual([
      "decisionAt",
      "instrumentSymbol",
      "long",
      "observedIn",
      "policyVersion",
      "short",
    ]);
  });

  it("pins an approved SideEdgeAssessment's and BaselineEdge's exact key sets", () => {
    const long = expectApprovedSide(approvedAssessment().long);
    expect(Object.keys(long).sort()).toEqual(["baselineEdge", "mlEdge", "side"]);
    expect(Object.keys(long.baselineEdge).sort()).toEqual([
      "costAdjustedBreakEvenHitRate",
      "costBps",
      "frictionlessBreakEvenHitRate",
      "rewardRiskMultiple",
      "roundTripCostR",
    ]);
  });

  it("invents no score/composite/rank/weight field anywhere", () => {
    const assessment = approvedAssessment();
    const long = expectApprovedSide(assessment.long);
    for (const key of [...Object.keys(assessment), ...Object.keys(long), ...Object.keys(long.baselineEdge)]) {
      expect(key).not.toMatch(/score|composite|rank|weight/i);
    }
  });

  it("costAdjustedBreakEvenHitRate equals the derived formula, not an arbitrary number", () => {
    const long = expectApprovedSide(approvedAssessment({ costBps: 3 }).long);
    const expected = (1 + long.baselineEdge.roundTripCostR) / (1 + long.baselineEdge.rewardRiskMultiple);
    expect(long.baselineEdge.costAdjustedBreakEvenHitRate).toBeCloseTo(expected, 12);
  });
});

describe("input validation", () => {
  it("throws on a negative costBps", () => {
    expect(() => assessEdge(input({ costBps: -1 }))).toThrow(EdgeAssessorError);
  });

  it("throws on a non-finite costBps", () => {
    expect(() => assessEdge(input({ costBps: Number.NaN }))).toThrow(/costBps/);
  });

  it("throws on an invalid context.decisionAt", () => {
    expect(() => assessEdge(input({
      context: { ...context(), decisionAt: new Date("not-a-date") },
    }))).toThrow(/valid Date/);
  });
});

describe("freezing and determinism", () => {
  it("freezes the assessment and each approved side", () => {
    const assessment = approvedAssessment();
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.long)).toBe(true);
  });

  it("produces an identical assessment for the same input twice", () => {
    const sameInput = input();
    expect(approvedAssessment(sameInput)).toEqual(approvedAssessment(sameInput));
  });
});
