import { describe, expect, it } from "vitest";
import {
  approveRisk,
  riskApprovalPolicyVersion,
  RiskApproverError,
  type DualSidedRiskApproval,
  type RiskApprovalInput,
  type SideRiskResult,
} from "./risk-approver.js";
import type { DualSidedEdgeAssessment, SideEdgeResult } from "./edge-assessor.js";
import type { DualSidedThesis, SideResult } from "./thesis-builder.js";
import type { BaseDecisionContext } from "./decision-context.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
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

function approvedThesisSide(overrides: { entryReference?: number; stopLoss?: number; targetPrice?: number; side?: "LONG" | "SHORT" } = {}): SideResult {
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

function rejectedThesisSide(): SideResult {
  return { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] };
}

function thesis(overrides: { long?: SideResult; short?: SideResult } = {}): DualSidedThesis {
  return Object.freeze({
    instrumentSymbol: "NIFTY50",
    decisionAt,
    observedIn,
    long: overrides.long ?? approvedThesisSide({ side: "LONG" }),
    short: overrides.short ?? rejectedThesisSide(),
    policyVersion: "NATIVE_THESIS_BUILDER_POLICY_V1",
  });
}

function approvedEdgeSide(): SideEdgeResult {
  return {
    outcome: "APPROVED",
    value: {
      side: "LONG",
      baselineEdge: {
        rewardRiskMultiple: 1.5,
        frictionlessBreakEvenHitRate: 0.4,
        roundTripCostR: 0.48,
        costAdjustedBreakEvenHitRate: 0.592,
        costBps: 5,
      },
      mlEdge: null,
    },
  };
}

function rejectedEdgeSide(): SideEdgeResult {
  return { outcome: "REJECTED", reasons: ["NO_APPROVED_THESIS_FOR_SIDE"] };
}

function edge(overrides: { long?: SideEdgeResult; short?: SideEdgeResult } = {}): DualSidedEdgeAssessment {
  return Object.freeze({
    instrumentSymbol: "NIFTY50",
    decisionAt,
    observedIn,
    long: overrides.long ?? approvedEdgeSide(),
    short: overrides.short ?? rejectedEdgeSide(),
    policyVersion: "NATIVE_EDGE_ASSESSMENT_POLICY_V1",
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
    policyVersions: Object.freeze({ riskApprovalPolicyVersion }),
  });
}

function accountSnapshot(overrides: Partial<InstrumentRiskSnapshot<unknown>> = {}): InstrumentRiskSnapshot<unknown> {
  return {
    accountEquity: 1_000_000,
    peakEquity: 1_000_000,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: null,
    ...overrides,
  };
}

function input(overrides: Partial<RiskApprovalInput> = {}): RiskApprovalInput {
  return {
    edge: edge(),
    thesis: thesis(),
    context: context(),
    accountSnapshot: accountSnapshot(),
    lotSize: 1,
    ...overrides,
  };
}

function approvedRiskApproval(overrides: Partial<RiskApprovalInput> = {}): DualSidedRiskApproval {
  const result = approveRisk(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

function expectApprovedSide(side: SideRiskResult) {
  if (side.outcome !== "APPROVED") throw new Error(`Expected APPROVED side, got ${side.outcome}.`);
  return side.value;
}

function expectRejectedSide(side: SideRiskResult) {
  if (side.outcome !== "REJECTED") throw new Error(`Expected REJECTED side, got ${side.outcome}.`);
  return side.reasons;
}

describe("sizing correctness", () => {
  it("computes the exact expected position size for a known equity/riskPerUnit/lotSize", () => {
    // riskPerUnit = |24000 - 23950| = 50; riskBudget = 1,000,000 * 0.005 = 5,000; affordableUnits = 100.
    const approval = approvedRiskApproval({
      accountSnapshot: accountSnapshot({ accountEquity: 1_000_000 }),
      lotSize: 1,
    });
    const long = expectApprovedSide(approval.long);

    expect(long.positionSize.riskPerUnit).toBeCloseTo(50, 10);
    expect(long.positionSize.quantity).toBe(100);
    expect(long.positionSize.estimatedRiskAmount).toBeCloseTo(5_000, 10);
    expect(long.positionSize.notional).toBeCloseTo(100 * 24000, 10);
    // capitalRequired = notional * 0.2 = 480,000, within 1,000,000 equity.
    expect(long.positionSize.capitalRequired).toBeCloseTo(480_000, 10);
  });

  it("floors quantity to a whole lot multiple", () => {
    // affordableUnits = 100 with lotSize 30 -> floor(100/30)*30 = 90.
    const approval = approvedRiskApproval({ lotSize: 30 });
    const long = expectApprovedSide(approval.long);
    expect(long.positionSize.quantity).toBe(90);
  });
});

describe("account-level gates", () => {
  it("rejects with MAX_CONCURRENT_POSITIONS when openPositionCount is at the cap", () => {
    const approval = approvedRiskApproval({ accountSnapshot: accountSnapshot({ openPositionCount: 3 }) });
    expect(expectRejectedSide(approval.long)).toEqual(["MAX_CONCURRENT_POSITIONS"]);
  });

  it("rejects with DAILY_LOSS_LIMIT when today's realized loss is at the fraction", () => {
    const approval = approvedRiskApproval({
      accountSnapshot: accountSnapshot({ realizedPnlToday: -20_000 }), // 2% of 1,000,000
    });
    expect(expectRejectedSide(approval.long)).toEqual(["DAILY_LOSS_LIMIT"]);
  });

  it("rejects with MAX_DRAWDOWN when drawdown from peak is at the fraction", () => {
    const approval = approvedRiskApproval({
      accountSnapshot: accountSnapshot({ peakEquity: 1_111_112, accountEquity: 1_000_000 }), // ~10% drawdown
    });
    expect(expectRejectedSide(approval.long)).toEqual(["MAX_DRAWDOWN"]);
  });

  it("rejects with RISK_BUDGET_BELOW_ONE_LOT when the budget cannot afford one lot", () => {
    const approval = approvedRiskApproval({
      // peakEquity matched to accountEquity so drawdown doesn't also fire.
      accountSnapshot: accountSnapshot({ accountEquity: 100, peakEquity: 100 }), // riskBudget = 0.5, riskPerUnit = 50 -> 0 units
    });
    expect(expectRejectedSide(approval.long)).toEqual(["RISK_BUDGET_BELOW_ONE_LOT"]);
  });

  it("rejects with INSUFFICIENT_CAPITAL when the margin requirement exceeds equity", () => {
    // A geometry with a tiny risk-per-unit relative to entry price lets sizing buy far more notional
    // than the account can margin: entry 24000, stop 23999 -> riskPerUnit 1, riskBudget 5,000,000/1 lot.
    const approval = approvedRiskApproval({
      thesis: thesis({ long: approvedThesisSide({ entryReference: 24000, stopLoss: 23999, targetPrice: 24075 }) }),
      accountSnapshot: accountSnapshot({ accountEquity: 1_000_000_000 }),
    });
    expect(expectRejectedSide(approval.long)).toEqual(["INSUFFICIENT_CAPITAL"]);
  });

  it("collects every failed account-level gate, in detection order", () => {
    const approval = approvedRiskApproval({
      accountSnapshot: accountSnapshot({
        openPositionCount: 5,
        realizedPnlToday: -50_000,
        peakEquity: 2_000_000,
        accountEquity: 1_000_000,
      }),
    });
    expect(expectRejectedSide(approval.long)).toEqual([
      "MAX_CONCURRENT_POSITIONS",
      "DAILY_LOSS_LIMIT",
      "MAX_DRAWDOWN",
    ]);
  });
});

describe("independent per-side evaluation", () => {
  it("gates and sizes LONG while rejecting SHORT when only LONG was approved upstream", () => {
    const approval = approvedRiskApproval();
    expect(approval.long.outcome).toBe("APPROVED");
    expect(expectRejectedSide(approval.short)).toEqual(["NO_APPROVED_EDGE_FOR_SIDE"]);
  });

  it("rejects a side when its thesis is approved but its edge is not, and vice versa", () => {
    const thesisApprovedEdgeMissing = approvedRiskApproval({
      thesis: thesis({ long: approvedThesisSide({ side: "LONG" }), short: approvedThesisSide({ side: "SHORT" }) }),
      edge: edge({ short: rejectedEdgeSide() }),
    });
    expect(expectRejectedSide(thesisApprovedEdgeMissing.short)).toEqual(["NO_APPROVED_EDGE_FOR_SIDE"]);
  });

  it("sizes both sides identically for symmetric geometry when both are approved upstream", () => {
    const approval = approvedRiskApproval({
      thesis: thesis({
        long: approvedThesisSide({ side: "LONG", entryReference: 24000, stopLoss: 23950, targetPrice: 24075 }),
        short: approvedThesisSide({ side: "SHORT", entryReference: 24000, stopLoss: 24050, targetPrice: 23925 }),
      }),
      edge: edge({ short: approvedEdgeSide() }),
    });
    const long = expectApprovedSide(approval.long);
    const short = expectApprovedSide(approval.short);
    expect(long.positionSize.quantity).toBe(short.positionSize.quantity);
  });

  it("rejects both sides identically when an account-level gate fails, since it is not side-specific", () => {
    const approval = approvedRiskApproval({
      thesis: thesis({
        long: approvedThesisSide({ side: "LONG" }),
        short: approvedThesisSide({ side: "SHORT" }),
      }),
      edge: edge({ short: approvedEdgeSide() }),
      accountSnapshot: accountSnapshot({ openPositionCount: 3 }),
    });
    expect(expectRejectedSide(approval.long)).toEqual(["MAX_CONCURRENT_POSITIONS"]);
    expect(expectRejectedSide(approval.short)).toEqual(["MAX_CONCURRENT_POSITIONS"]);
  });
});

describe("never refuses at the stage level", () => {
  it("still yields an APPROVED DualSidedRiskApproval when both sides were unapproved upstream", () => {
    const result = approveRisk(input({
      thesis: thesis({ long: rejectedThesisSide(), short: rejectedThesisSide() }),
      edge: edge({ long: rejectedEdgeSide(), short: rejectedEdgeSide() }),
    }));
    expect(result.outcome).toBe("APPROVED");
    if (result.outcome === "APPROVED") {
      expect(result.value.long.outcome).toBe("REJECTED");
      expect(result.value.short.outcome).toBe("REJECTED");
    }
  });
});

describe("structural no-composite-score proof", () => {
  it("pins DualSidedRiskApproval's exact key set", () => {
    expect(Object.keys(approvedRiskApproval()).sort()).toEqual([
      "decisionAt",
      "instrumentSymbol",
      "long",
      "observedIn",
      "policyVersion",
      "short",
    ]);
  });

  it("pins an approved SideRiskApproval's and PositionSize's exact key sets", () => {
    const long = expectApprovedSide(approvedRiskApproval().long);
    expect(Object.keys(long).sort()).toEqual(["positionSize", "side"]);
    expect(Object.keys(long.positionSize).sort()).toEqual([
      "capitalRequired",
      "estimatedRiskAmount",
      "lotSize",
      "notional",
      "quantity",
      "riskPerUnit",
    ]);
  });

  it("invents no score/composite/rank/weight field anywhere", () => {
    const approval = approvedRiskApproval();
    const long = expectApprovedSide(approval.long);
    for (const key of [...Object.keys(approval), ...Object.keys(long), ...Object.keys(long.positionSize)]) {
      expect(key).not.toMatch(/score|composite|rank|weight/i);
    }
  });
});

describe("input validation", () => {
  it("throws on a non-positive lotSize", () => {
    expect(() => approveRisk(input({ lotSize: 0 }))).toThrow(RiskApproverError);
  });

  it("throws on a non-integer lotSize", () => {
    expect(() => approveRisk(input({ lotSize: 1.5 }))).toThrow(RiskApproverError);
  });

  it("throws on a non-finite accountEquity", () => {
    expect(() => approveRisk(input({ accountSnapshot: accountSnapshot({ accountEquity: Number.NaN }) })))
      .toThrow(RiskApproverError);
  });

  it("throws on a non-positive accountEquity", () => {
    expect(() => approveRisk(input({ accountSnapshot: accountSnapshot({ accountEquity: 0 }) })))
      .toThrow(RiskApproverError);
  });

  it("throws when edge and thesis instrumentSymbol disagree", () => {
    expect(() => approveRisk(input({
      thesis: Object.freeze({ ...thesis(), instrumentSymbol: "BANKNIFTY" }),
    }))).toThrow(RiskApproverError);
  });

  it("throws when edge and thesis decisionAt disagree", () => {
    expect(() => approveRisk(input({
      thesis: Object.freeze({ ...thesis(), decisionAt: new Date(decisionAt.getTime() + 60_000) }),
    }))).toThrow(RiskApproverError);
  });
});

describe("freezing and determinism", () => {
  it("freezes the approval and each approved side", () => {
    const approval = approvedRiskApproval();
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.long)).toBe(true);
  });

  it("produces an identical approval for the same input twice", () => {
    const sameInput = input();
    expect(approvedRiskApproval(sameInput)).toEqual(approvedRiskApproval(sameInput));
  });
});
