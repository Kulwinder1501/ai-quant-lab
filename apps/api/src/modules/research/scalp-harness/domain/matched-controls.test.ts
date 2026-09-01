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

describe("matched-control population homogeneity (D4)", () => {
  const homogeneous = () => Array.from({ length: 8 }, (_, index) => control(index));

  it("is a no-op when every eligible control shares one population version", () => {
    /*
     * The claim this rule rests on. `controlPolicyVersion` was persisted on every control point and
     * enforced by nothing; adding enforcement is only safe if it changes nothing on the population
     * that exists.
     *
     * Measured before it was added: no session mixes versions (V1 is 2026-08-24 alone, V2 every session
     * after), matching is within-session, and 0 of 1,822 stored matched sets are mixed. This asserts the
     * same property at unit level, so a future change that quietly starts filtering by version -- rather
     * than by homogeneity -- fails here.
     */
    const controls = homogeneous();
    const result = matchControls({
      opportunity, selectedVolatilityRegime: "LOW_VOL", controls, treatedDecisionKeys: new Set(),
    });

    expect(result.commonSupport).toBe(true);
    expect(result.reason).toBe("MATCHED");
    expect(result.controlIds).toHaveLength(5);
  });

  it("refuses a pool spanning two population versions rather than choosing one", () => {
    /*
     * Each version widened what `sampleEligible` asserts -- V1 read "canonical ATR exists", V2 "every
     * consumed 1m indicator plus both feature layers", V3 adds "and the tape was moving" -- so a set
     * drawn across a boundary compares points admitted under different rules and its baseline is not one
     * population.
     *
     * Refusing rather than picking the larger group: the matcher has no basis for preferring a version,
     * and silently choosing would produce a baseline nobody selected.
     */
    const controls = homogeneous().map((item, index) => (
      index < 3 ? { ...item, controlPolicyVersion: "MATCHED_CONTROL_POPULATION_V2:GRID_POLICY_V1" } : item
    ));

    const result = matchControls({
      opportunity, selectedVolatilityRegime: "LOW_VOL", controls, treatedDecisionKeys: new Set(),
    });

    expect(result.commonSupport).toBe(false);
    expect(result.reason).toBe("MIXED_CONTROL_POLICY_VERSION");
    expect(result.controlIds).toEqual([]);
    expect(result.equalWeight).toBeNull();
    // The caliper count is still reported, so a reader can see the pool was large enough and the
    // refusal was about its composition rather than its size.
    expect(result.candidatesInsideCaliper).toBeGreaterThanOrEqual(5);
  });

  it("keeps the mixed refusal distinct from insufficient support", () => {
    // Two different problems: too few comparable points, versus enough points that are not comparable.
    // Collapsing them would hide a mid-session version boundary inside a familiar reason code.
    const tooFew = matchControls({
      opportunity, selectedVolatilityRegime: "LOW_VOL",
      controls: homogeneous().slice(0, 2), treatedDecisionKeys: new Set(),
    });

    expect(tooFew.reason).toBe("INSUFFICIENT_COMMON_SUPPORT");
    expect(tooFew.reason).not.toBe("MIXED_CONTROL_POLICY_VERSION");
  });

  it("ignores the version of controls the caliper already excluded", () => {
    /*
     * Homogeneity is judged on the *eligible* pool, not on everything handed in. A control from another
     * version outside the caliper, or in the wrong regime, was never a candidate -- refusing because of
     * it would block matching on a control that could not have been selected.
     */
    const farAway = { ...control(60), controlPolicyVersion: "MATCHED_CONTROL_POPULATION_V1:GRID_POLICY_V1" };
    const result = matchControls({
      opportunity, selectedVolatilityRegime: "LOW_VOL",
      controls: [...homogeneous(), farAway], treatedDecisionKeys: new Set(),
    });

    expect(result.reason).toBe("MATCHED");
    expect(result.controlIds).toHaveLength(5);
  });
});
