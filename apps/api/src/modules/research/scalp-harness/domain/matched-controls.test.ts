import { describe, expect, it } from "vitest";
import type { MarketOpportunity, ResearchControlPoint } from "./contracts.js";
import { matchControls } from "./matched-controls.js";

const decision = new Date("2026-08-21T04:30:00Z");
const opportunity: MarketOpportunity & { id: string } = {
  id: "opportunity", opportunityKey: "a".repeat(64), payloadHash: "b".repeat(64), instrumentId: "instrument",
  sessionId: "2026-08-21", sessionCloseAt: new Date("2026-08-21T10:00:00Z"), direction: "LONG",
  canonicalDecisionAt: decision, dataThrough: new Date(decision.getTime() - 1), referencePrice: 100,
  referenceCandleId: "reference", proposalIds: [], groupingPolicyVersion: "group", referencePolicyVersion: "reference",
};

function control(index: number, regime = "LOW_VOL"): ResearchControlPoint & { id: string } {
  const at = new Date(decision.getTime() + (index - 3) * 60_000);
  return {
    id: `c${index}`, controlPointKey: String(index).padStart(64, "0"), payloadHash: "b".repeat(64),
    instrumentId: "instrument", sourceCandleId: `bar${index}`, sessionId: "2026-08-21",
    sessionCloseAt: opportunity.sessionCloseAt, evaluationDirection: "LONG", decisionAt: at,
    dataThrough: new Date(at.getTime() - 1), referencePrice: 100, minuteOfDay: 270 + index,
    volatilityRegime: regime, sampleEligible: true, ineligibleReason: null, controlPolicyVersion: "control",
  };
}

describe("outcome-blind matched controls", () => {
  it("selects five reproducibly with exact regime and treated-point exclusion", () => {
    const controls = Array.from({ length: 8 }, (_, index) => control(index));
    const treated = new Set([`instrument|LONG|${controls[3]!.decisionAt.toISOString()}`]);
    const first = matchControls({ opportunity, selectedVolatilityRegime: "LOW_VOL", controls, treatedDecisionKeys: treated });
    const second = matchControls({ opportunity, selectedVolatilityRegime: "LOW_VOL", controls, treatedDecisionKeys: treated });
    expect(first.commonSupport).toBe(true);
    expect(first.controlIds).toEqual(second.controlIds);
    expect(first.controlIds).toHaveLength(5);
    expect(first.controlIds).not.toContain("c3");
    expect(first.equalWeight).toBe(0.2);
  });

  it("reports common-support failure instead of silently reducing N", () => {
    const result = matchControls({ opportunity, selectedVolatilityRegime: "HIGH_VOL", controls: [control(1)], treatedDecisionKeys: new Set() });
    expect(result).toMatchObject({ commonSupport: false, reason: "INSUFFICIENT_COMMON_SUPPORT", controlIds: [] });
  });
});
