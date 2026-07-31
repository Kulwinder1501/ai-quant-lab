import { describe, expect, it } from "vitest";
import {
  defaultRiskPolicy,
  evaluateRisk,
  riskReasonCodes,
  type RiskProposal,
  type RiskState,
} from "./risk.js";

const DECISION_AT = new Date("2026-07-31T06:30:00.000Z");

function proposal(overrides: Partial<RiskProposal> = {}): RiskProposal {
  return {
    instrumentId: "instrument-1",
    decisionTimestamp: DECISION_AT,
    side: "LONG",
    entryPrice: 24_000,
    stopLoss: 23_900,
    targetPrice: 24_200,
    ...overrides,
  };
}

function state(overrides: Partial<RiskState> = {}): RiskState {
  return {
    accountEquity: 5_000_000,
    peakEquity: 5_000_000,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: {
      prediction: "STABLE",
      confidence: 0.7,
      evidenceCutoffAt: new Date("2026-07-31T06:00:00.000Z"),
    },
    ...overrides,
  };
}

describe("evaluateRisk", () => {
  it("sizes from the risk budget and the trade's own stop distance", () => {
    // 0.5% of 5,000,000 is 25,000 at risk over a 100-point stop, so 250 units.
    const decision = evaluateRisk(proposal(), state());

    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(250);
    expect(decision.estimatedRiskAmount).toBe(25_000);
    expect(decision.reasonCodes).toContain(riskReasonCodes.approved);
  });

  it("halves size when expansion is predicted, rather than blocking the trade", () => {
    const decision = evaluateRisk(proposal(), state({
      volatilityRegime: { prediction: "EXPANSION", confidence: 0.8, evidenceCutoffAt: new Date("2026-07-31T06:00:00.000Z") },
    }));

    // Predicted expansion makes a fixed stop likelier to be hit: commit less, but the
    // signal says nothing about direction, so it cannot veto the side.
    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(125);
    expect(decision.reasonCodes).toContain(riskReasonCodes.sizeReducedForExpansion);
  });

  it("does not shrink size for contraction or stable regimes", () => {
    for (const prediction of ["CONTRACTION", "STABLE"] as const) {
      const decision = evaluateRisk(proposal(), state({
        volatilityRegime: { prediction, confidence: 0.9, evidenceCutoffAt: new Date("2026-07-31T06:00:00.000Z") },
      }));
      expect(decision.approvedQuantity).toBe(250);
      expect(decision.reasonCodes).not.toContain(riskReasonCodes.sizeReducedForExpansion);
    }
  });

  it("ignores a regime it is not confident about instead of acting on noise", () => {
    const decision = evaluateRisk(proposal(), state({
      volatilityRegime: { prediction: "EXPANSION", confidence: 0.3, evidenceCutoffAt: new Date("2026-07-31T06:00:00.000Z") },
    }));

    expect(decision.approvedQuantity).toBe(250);
    expect(decision.reasonCodes).toContain(riskReasonCodes.regimeIgnoredLowConfidence);
  });

  it("refuses a regime whose evidence closes after the decision", () => {
    // Reading this would be leakage: the prediction did not exist yet.
    const decision = evaluateRisk(proposal(), state({
      volatilityRegime: { prediction: "EXPANSION", confidence: 0.9, evidenceCutoffAt: new Date("2026-07-31T07:00:00.000Z") },
    }));

    expect(decision.approved).toBe(false);
    expect(decision.reasonCodes).toContain(riskReasonCodes.regimeFromFuture);
  });

  it("still approves at full size when no regime is available, but says so", () => {
    const decision = evaluateRisk(proposal(), state({ volatilityRegime: null }));

    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(250);
    expect(decision.reasonCodes).toContain(riskReasonCodes.regimeUnavailable);
  });

  it("blocks a new entry once the position limit is reached", () => {
    const decision = evaluateRisk(proposal(), state({ openPositionCount: defaultRiskPolicy.maxConcurrentPositions }));

    expect(decision.approved).toBe(false);
    expect(decision.approvedQuantity).toBe(0);
    expect(decision.reasonCodes).toContain(riskReasonCodes.maxConcurrentPositions);
  });

  it("blocks a new entry after the daily loss limit is reached", () => {
    // 2% of 5,000,000 is 100,000.
    const atLimit = evaluateRisk(proposal(), state({ realizedPnlToday: -100_000 }));
    const inside = evaluateRisk(proposal(), state({ realizedPnlToday: -99_999 }));

    expect(atLimit.reasonCodes).toContain(riskReasonCodes.dailyLossLimit);
    expect(inside.approved).toBe(true);
  });

  it("blocks a new entry while drawdown from peak exceeds the limit", () => {
    const decision = evaluateRisk(proposal(), state({ accountEquity: 4_400_000, peakEquity: 5_000_000 }));

    expect(decision.approved).toBe(false);
    expect(decision.reasonCodes).toContain(riskReasonCodes.maxDrawdown);
  });

  it("rejects when the risk budget cannot buy a whole unit", () => {
    // A stop 1,000,000 points away cannot be sized at any sane equity.
    const decision = evaluateRisk(
      proposal({ entryPrice: 24_000, stopLoss: 1, targetPrice: 30_000 }),
      state({ accountEquity: 1_000 }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.reasonCodes).toContain(riskReasonCodes.unsizable);
  });

  it("rejects geometry that is not internally coherent", () => {
    // Stop above entry on a long is not a stop.
    expect(evaluateRisk(proposal({ stopLoss: 24_100 }), state()).reasonCodes)
      .toContain(riskReasonCodes.invalidGeometry);
    // Target below entry on a long is not a target.
    expect(evaluateRisk(proposal({ targetPrice: 23_000 }), state()).reasonCodes)
      .toContain(riskReasonCodes.invalidGeometry);
    // Mirrored for a short.
    expect(evaluateRisk(proposal({ side: "SHORT" }), state()).reasonCodes)
      .toContain(riskReasonCodes.invalidGeometry);
  });

  it("accepts a coherent short", () => {
    const decision = evaluateRisk(
      proposal({ side: "SHORT", entryPrice: 24_000, stopLoss: 24_100, targetPrice: 23_800 }),
      state(),
    );

    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(250);
  });

  it("reports every failed check, not only the first", () => {
    const decision = evaluateRisk(proposal(), state({
      openPositionCount: 5,
      realizedPnlToday: -500_000,
      accountEquity: 4_000_000,
      peakEquity: 5_000_000,
    }));

    expect(decision.approved).toBe(false);
    expect(decision.reasonCodes).toContain(riskReasonCodes.maxConcurrentPositions);
    expect(decision.reasonCodes).toContain(riskReasonCodes.dailyLossLimit);
    expect(decision.reasonCodes).toContain(riskReasonCodes.maxDrawdown);
  });

  it("rejects rather than approves when equity is missing or nonsensical", () => {
    for (const accountEquity of [0, -1, Number.NaN]) {
      const decision = evaluateRisk(proposal(), state({ accountEquity }));
      expect(decision.approved).toBe(false);
      expect(decision.reasonCodes).toContain(riskReasonCodes.insufficientCapital);
    }
  });

  it("never returns an approved decision without a size or prices", () => {
    const rejected = evaluateRisk(proposal(), state({ openPositionCount: 99 }));

    expect(rejected.approved).toBe(false);
    expect(rejected.approvedQuantity).toBe(0);
    expect(rejected.approvedEntryPrice).toBeNull();
    expect(rejected.approvedStopLoss).toBeNull();
    expect(rejected.approvedTargetPrice).toBeNull();
    expect(rejected.estimatedRiskAmount).toBe(0);
  });
});
