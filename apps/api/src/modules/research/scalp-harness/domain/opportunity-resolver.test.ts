import { describe, expect, it } from "vitest";
import type { ImmutableStrategyProposal } from "./contracts.js";
import { resolveOpportunities } from "./opportunity-resolver.js";

const decision = new Date("2026-08-21T04:30:00.000Z");
function proposal(id: string, overrides: Partial<ImmutableStrategyProposal> = {}): ImmutableStrategyProposal & { id: string } {
  return {
    id, proposalKey: id.padEnd(64, "a").slice(0, 64), payloadHash: "b".repeat(64),
    strategyDefinitionHash: "c".repeat(64), strategyKey: `strategy-${id}`, strategyResearchVersion: 1,
    instrumentId: "instrument", sourceCandleId: "source", referenceCandleId: "reference", timeframe: "1m",
    direction: "LONG", decisionAt: decision, dataThrough: new Date(decision.getTime() - 1), referencePrice: 100,
    setupType: "SETUP", setupFingerprint: "d".repeat(64), rawContext: {},
    nativeGeometry: { direction: "LONG", entryOrderType: "MARKET_AT_REFERENCE", entryPrice: 100,
      stopLoss: 99, targetPrice: 101.5, expiresAt: new Date(decision.getTime() + 60_000), geometryPolicyVersion: "NATIVE" },
    ...overrides,
  };
}

describe("opportunity resolver", () => {
  it("groups without selecting proposal geometry or multiplying observations", () => {
    const [result] = resolveOpportunities([proposal("p2"), proposal("p1")], new Date("2026-08-21T10:00:00Z"));
    expect(result.proposalIds).toEqual(["p1", "p2"]);
    expect(result).not.toHaveProperty("entryPrice");
    expect(result).not.toHaveProperty("confidence");
  });

  it("rejects peers with different canonical reference evidence", () => {
    expect(() => resolveOpportunities([
      proposal("p1"), proposal("p2", { referencePrice: 100.1 }),
    ], new Date("2026-08-21T10:00:00Z"))).toThrow(/inconsistent reference/);
  });
});
