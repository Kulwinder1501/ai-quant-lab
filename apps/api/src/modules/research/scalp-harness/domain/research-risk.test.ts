import { describe, expect, it } from "vitest";
import { buildRiskSnapshot, buildRiskSubject, evaluateResearchRisk } from "./research-risk.js";

const decisionAt = new Date("2026-08-21T04:30:00Z");
const state = {
  accountEquity: 100_000,
  peakEquity: 100_000,
  openPositionCount: 0,
  realizedPnlToday: 0,
  volatilityEvidenceByInstrument: {
    instrument: { prediction: "STABLE" as const, confidence: 0.8, evidenceCutoffAt: decisionAt },
  },
};

describe("research-only risk evaluation", () => {
  it("evaluates an immutable geometry subject without an execution action", () => {
    const snapshot = { ...buildRiskSnapshot({ accountId: "account", asOf: decisionAt, decisionAt, state }), id: "snapshot" };
    const subject = { ...buildRiskSubject({
      subjectType: "CANONICAL_OPPORTUNITY", subjectId: "opportunity", instrumentId: "instrument", decisionAt,
      sessionCloseAt: new Date(decisionAt.getTime() + 120 * 60_000), lotSize: 1,
      geometry: { direction: "LONG", entryOrderType: "MARKET_AT_REFERENCE", entryPrice: 100,
        stopLoss: 99, targetPrice: 101.5, expiresAt: new Date(decisionAt.getTime() + 60 * 60_000), geometryPolicyVersion: "CANONICAL" },
    }), id: "subject-row" };
    const result = evaluateResearchRisk({ subject, snapshot });
    expect(result.decision.approved).toBe(true);
    expect(result).not.toHaveProperty("execute");
  });

  it("rejects future volatility evidence at snapshot construction", () => {
    expect(() => buildRiskSnapshot({
      accountId: "account", asOf: decisionAt, decisionAt,
      state: { ...state, volatilityEvidenceByInstrument: {
        instrument: { prediction: "STABLE", confidence: 0.8, evidenceCutoffAt: new Date(decisionAt.getTime() + 1) },
      } },
    })).toThrow(/future volatility/);
  });

  it("records an exact-close subject whose forward outcomes will be session-ineligible", () => {
    expect(() => buildRiskSubject({
      subjectType: "CANONICAL_OPPORTUNITY", subjectId: "closing-opportunity", instrumentId: "instrument",
      decisionAt, sessionCloseAt: decisionAt, lotSize: 1,
      geometry: { direction: "LONG", entryOrderType: "MARKET_AT_REFERENCE", entryPrice: 100,
        stopLoss: 99, targetPrice: 101.5, expiresAt: new Date(decisionAt.getTime() + 60 * 60_000),
        geometryPolicyVersion: "CANONICAL" },
    })).not.toThrow();
  });
});
