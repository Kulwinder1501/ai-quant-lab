import { describe, expect, it } from "vitest";
import {
  applyOrderbookGateToProposal,
  evaluateOrderbookDirectionalGate,
} from "./orderbook-directional-gate.js";
import type { ProposedTradeIdea } from "./strategy.js";

function proposal(overrides: Partial<ProposedTradeIdea> = {}): ProposedTradeIdea {
  return {
    side: "LONG",
    entryPrice: 100,
    stopLoss: 90,
    targetPrice: 115,
    riskReward: 1.5,
    confidence: 0.63,
    reasoning: [],
    evidence: {},
    expiresAt: null,
    evidenceItems: [],
    ...overrides,
  };
}

describe("evaluateOrderbookDirectionalGate", () => {
  it("is NEUTRAL and inactive when no confluence signal is supplied", () => {
    expect(evaluateOrderbookDirectionalGate("LONG", null)).toMatchObject({
      isGateActive: false,
      gateStatus: "NEUTRAL",
      confidenceAdjustment: 0,
    });
  });

  it("is NEUTRAL when a level is proximate but the orderbook has no directional recommendation", () => {
    const result = evaluateOrderbookDirectionalGate("LONG", {
      is_level_proximate: true,
      gate_action: "NO_ACTION",
    });
    expect(result).toMatchObject({ isGateActive: true, gateStatus: "NEUTRAL", confidenceAdjustment: 0 });
  });

  it("PASSes with a 0-1-scale adjustment when the proposal's side agrees with the recommendation", () => {
    const result = evaluateOrderbookDirectionalGate("LONG", {
      is_level_proximate: true,
      gate_action: "BUY_CALL_OR_LONG",
      directional_bias: "BULLISH_REJECTION",
    });
    expect(result.gateStatus).toBe("PASS");
    expect(result.confidenceAdjustment).toBe(0.15);
  });

  it("BLOCKs with a 0-1-scale adjustment when the proposal's side conflicts with the recommendation", () => {
    const result = evaluateOrderbookDirectionalGate("LONG", {
      is_level_proximate: true,
      gate_action: "BUY_PUT_OR_SHORT",
      directional_bias: "BEARISH_REJECTION",
    });
    expect(result.gateStatus).toBe("BLOCK");
    expect(result.confidenceAdjustment).toBe(-0.30);
  });
});

/**
 * `confidenceAdjustment` used to be sized for a 0-100 confidence scale (+15/-30) and clamped to
 * [0, 100] -- but every strategy in this codebase produces `confidence` on [0, 1]. A live PASS or
 * BLOCK verdict would have added or subtracted 15/30 *whole points* to a fractional score. Found
 * 2026-09-30, never yet triggered live (every recorded verdict so far has been NEUTRAL).
 */
describe("applyOrderbookGateToProposal confidence scale", () => {
  it("adds a fractional adjustment on PASS, staying within [0, 1]", () => {
    const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63, side: "LONG" }), {
      is_level_proximate: true,
      gate_action: "BUY_CALL_OR_LONG",
      directional_bias: "BULLISH_REJECTION",
    });
    expect(updated.confidence).toBeCloseTo(0.78, 10);
  });

  it("subtracts a fractional adjustment on BLOCK, clamped at 0 rather than going deeply negative", () => {
    const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.2, side: "LONG" }), {
      is_level_proximate: true,
      gate_action: "BUY_PUT_OR_SHORT",
      directional_bias: "BEARISH_REJECTION",
    });
    // 0.2 - 0.30 = -0.10, clamped to 0 -- not the old bug's 0.2 - 30 = -29.8, clamped to 0 either
    // way, which hid the scale error rather than catching it.
    expect(updated.confidence).toBe(0);
  });

  it("never lets an adjustment push confidence above 1, even on a high-confidence PASS", () => {
    const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.95, side: "LONG" }), {
      is_level_proximate: true,
      gate_action: "BUY_CALL_OR_LONG",
      directional_bias: "BULLISH_REJECTION",
    });
    expect(updated.confidence).toBeLessThanOrEqual(1);
    expect(updated.confidence).toBeCloseTo(1, 10);
  });

  it("leaves confidence untouched on NEUTRAL, only attaching shadow evidence", () => {
    const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63 }), null);
    expect(updated.confidence).toBe(0.63);
    expect(updated.evidence.orderbookGate).toMatchObject({ gateStatus: "NEUTRAL", shadowVerdict: "NEUTRAL" });
  });
});
