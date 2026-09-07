import { describe, expect, it } from "vitest";
import {
  assertOnGridDecision,
  assertSettlementPolicyDeterminism,
  PolicyDeterminismViolationError,
  resolveSettlementPolicy,
  settlementPolicyVersion,
} from "./contracts.js";

/** 09:16 IST on a 2026 session, as UTC — the first legal 1m grid point. */
function ist(hour: number, minute: number, seconds = 0, ms = 0): Date {
  return new Date(Date.UTC(2026, 7, 3, hour - 5, minute - 30, seconds, ms));
}

describe("GRID_POLICY_V1 enforcement", () => {
  it("accepts a whole-minute decision inside the session", () => {
    expect(() => assertOnGridDecision(ist(9, 16))).not.toThrow();
    expect(() => assertOnGridDecision(ist(15, 30))).not.toThrow();
  });

  it("rejects an off-grid decision even though a feed produced it", () => {
    // The exact defect the assertion exists for: a bar sealed mid-minute is not a grid point, and an
    // off-grid control silently corrupts the +/-15-minute caliper.
    expect(() => assertOnGridDecision(ist(9, 16, 12))).toThrow(/whole-minute/);
    expect(() => assertOnGridDecision(ist(9, 17, 0, 500))).toThrow(/whole-minute/);
  });

  it("rejects decisions outside the regular session, including the anchor itself", () => {
    // 09:15 is the anchor, not a decision: the first 1m bar closes at 09:16.
    expect(() => assertOnGridDecision(ist(9, 15))).toThrow(/outside the regular session/);
    expect(() => assertOnGridDecision(ist(15, 31))).toThrow(/outside the regular session/);
    expect(() => assertOnGridDecision(ist(18, 30))).toThrow(/outside the regular session/);
  });

  it("refuses an invalid timestamp rather than hashing one", () => {
    expect(() => assertOnGridDecision(new Date(Number.NaN))).toThrow(/valid decision timestamp/);
  });
});

describe("settlement policy registry", () => {
  it("resolves the frozen version to its component set", () => {
    const definition = resolveSettlementPolicy(settlementPolicyVersion);
    expect(definition.fillPolicyVersion).toBe("FILL_POLICY_V1");
    expect(definition.geometryPolicyVersion).toBe("CANONICAL_GEOMETRY_V1");
    expect(definition.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unregistered settlement version", () => {
    expect(() => resolveSettlementPolicy("SCALP_SETTLEMENT_V99")).toThrow(/not registered/);
  });

  it("raises POLICY_DETERMINISM_VIOLATION when stored rows predate a component change", () => {
    // Simulates the illegal edit the registry exists to catch: same version string, different
    // component set. Detected globally against stored rows, not only on re-settlement.
    expect(() => assertSettlementPolicyDeterminism(settlementPolicyVersion, "0".repeat(64)))
      .toThrow(PolicyDeterminismViolationError);
    expect(() => assertSettlementPolicyDeterminism(settlementPolicyVersion, "0".repeat(64)))
      .toThrow(/POLICY_DETERMINISM_VIOLATION/);
  });

  it("passes when the stored hash still matches the registry", () => {
    const current = resolveSettlementPolicy(settlementPolicyVersion).definitionHash;
    expect(() => assertSettlementPolicyDeterminism(settlementPolicyVersion, current)).not.toThrow();
  });
});
