import { describe, expect, it } from "vitest";
import { buildCanonicalGeometry, roundCanonicalGeometry } from "./policies.js";
import type { MarketOpportunity } from "./contracts.js";

const decisionAt = new Date("2026-08-21T04:30:00.000Z");
const opportunity: MarketOpportunity = {
  opportunityKey: "a".repeat(64), payloadHash: "b".repeat(64), instrumentId: "instrument",
  sessionId: "2026-08-21", sessionCloseAt: new Date("2026-08-21T10:00:00.000Z"), direction: "LONG",
  canonicalDecisionAt: decisionAt, dataThrough: new Date(decisionAt.getTime() - 1), referencePrice: 100.03,
  referenceCandleId: "candle", proposalIds: [], groupingPolicyVersion: "group", referencePolicyVersion: "reference",
};

describe("CANONICAL_GEOMETRY_V1", () => {
  it("uses explicit adverse tick directions", () => {
    expect(roundCanonicalGeometry({ direction: "LONG", entry: 100.03, stop: 99.03, target: 101.53, tickSize: 0.05 }))
      .toEqual({ entryPrice: 100.05, stopLoss: 99, targetPrice: 101.55 });
    expect(roundCanonicalGeometry({ direction: "SHORT", entry: 100.03, stop: 101.03, target: 98.53, tickSize: 0.05 }))
      .toEqual({ entryPrice: 100, stopLoss: 101.05, targetPrice: 98.5 });
  });

  it("builds 1 ATR / 1.5 ATR geometry and rejects a cross-session terminal", () => {
    const result = buildCanonicalGeometry({ opportunity, atr: 1, tickSize: 0.05, sessionCloseAt: new Date(decisionAt.getTime() + 30 * 60_000) });
    expect(result.geometry).toMatchObject({ entryPrice: 100.05, stopLoss: 99, targetPrice: 101.55 });
    expect(result.terminalEligible).toBe(false);
    expect(result.terminalIneligibleReason).toBe("SESSION_BOUNDARY");
  });
});
