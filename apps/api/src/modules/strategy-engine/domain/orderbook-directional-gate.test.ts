import { describe, expect, it } from "vitest";
import {
  applyOrderbookGateToProposal,
  evaluateOrderbookDirectionalGate,
  resolveConfluenceSignalFromDepth,
  type DepthFrameLevelData,
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
 * `resolveConfluenceSignalFromDepth` negates raw DI into `di_tilde` before the directional
 * read. `apps/ml/run_orderbook01_oos.py` (the frozen OOS validator this gate implements)
 * applies `di_tilde = -di` UNIFORMLY to Tier 1 (SWING/ITH/ITL/SESSION) and Tier 2 (PDL) alike --
 * see its module docstring, which states "DI_tilde = -DI" for both tiers. This gate used to
 * negate only for Tier 1 (`isTier1 ? -rawDi : rawDi`), leaving Tier 2/PDL on the raw, un-negated
 * sign: the opposite convention from what was actually backtested. Fixed 2026-10-05 to negate
 * uniformly. These tests pin the sign convention for both tiers so a reintroduced asymmetry
 * fails loudly.
 */
describe("resolveConfluenceSignalFromDepth DI_tilde sign convention", () => {
  // total_sell_qty > total_buy_qty => rawDi < 0 => di_tilde = -rawDi > 0.
  const sellDominantDepth: DepthFrameLevelData = {
    totalBuyQty: 200,
    totalSellQty: 800,
    bidPrice: [100],
    bidQty: [200],
    askPrice: [101],
    askQty: [800],
  };

  // total_buy_qty > total_sell_qty => rawDi > 0 => di_tilde = -rawDi < 0.
  const buyDominantDepth: DepthFrameLevelData = {
    totalBuyQty: 800,
    totalSellQty: 200,
    bidPrice: [100],
    bidQty: [800],
    askPrice: [101],
    askQty: [200],
  };

  it("negates raw DI for a Tier 1 level (SESSION_HIGH): sell-dominant depth flags BEARISH_REJECTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
    });
    expect(signal.raw_di).toBeCloseTo(-0.6, 10);
    expect(signal.di_tilde).toBeCloseTo(0.6, 10);
    expect(signal.directional_bias).toBe("BEARISH_REJECTION");
    expect(signal.gate_action).toBe("BUY_PUT_OR_SHORT");
  });

  it("negates raw DI for a Tier 2 level (PDL): sell-dominant depth flags BEARISH_SWEEP, not NO_ACTION", () => {
    // Before the fix, Tier 2 used the raw (un-negated) DI: di_tilde would have stayed -0.6,
    // failing the `di_tilde > 0` check entirely and reporting NO_ACTION/NONE here -- silently
    // dropping a signal the OOS validator would have scored as a sweep.
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "PDL",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
    });
    expect(signal.raw_di).toBeCloseTo(-0.6, 10);
    expect(signal.di_tilde).toBeCloseTo(0.6, 10);
    expect(signal.directional_bias).toBe("BEARISH_SWEEP");
    expect(signal.gate_action).toBe("BUY_PUT_OR_SHORT");
  });

  it("Tier 1 and Tier 2 agree in sign on the same depth snapshot (uniform negation)", () => {
    const tier1Signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "ITH",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: buyDominantDepth,
    });
    const tier2Signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "PDL",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: buyDominantDepth,
    });
    // Same raw_di input (buy-dominant => rawDi > 0) must negate to the same-signed di_tilde
    // for both tiers -- Tier 1 historically did this correctly; Tier 2 did not.
    expect(tier1Signal.raw_di).toBeCloseTo(0.6, 10);
    expect(tier2Signal.raw_di).toBeCloseTo(0.6, 10);
    expect(tier1Signal.di_tilde).toBeCloseTo(-0.6, 10);
    expect(tier2Signal.di_tilde).toBeCloseTo(-0.6, 10);
    // di_tilde < 0 for both means neither predicts its tier's "di_tilde > 0" outcome here.
    expect(tier1Signal.gate_action).toBe("NO_ACTION");
    expect(tier2Signal.gate_action).toBe("NO_ACTION");
  });

  it("negates raw DI for a Tier 1 LOW level: sell-dominant depth flags BULLISH_REJECTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_LOW",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
    });
    expect(signal.di_tilde).toBeCloseTo(0.6, 10);
    expect(signal.directional_bias).toBe("BULLISH_REJECTION");
    expect(signal.gate_action).toBe("BUY_CALL_OR_LONG");
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
