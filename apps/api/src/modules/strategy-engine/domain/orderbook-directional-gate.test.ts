import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOrderbookGateToProposal,
  calculateDecayingDepthImbalance,
  causalStandardiseDi,
  DI_STANDARDISATION_MIN_HISTORY_MINUTES,
  evaluateOrderbookDirectionalGate,
  resolveConfluenceSignalFromDepth,
  trailingMinuteDiSamples,
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

/** A causal DI history (one value per prior minute) with the given constant level. */
function flatHistory(level: number, minutes = 20): number[] {
  return Array.from({ length: minutes }, () => level);
}

let originalFlag: string | undefined;
beforeEach(() => {
  originalFlag = process.env.ORDERBOOK01_LIVE_GATE_ENABLED;
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ORDERBOOK01_LIVE_GATE_ENABLED;
  else process.env.ORDERBOOK01_LIVE_GATE_ENABLED = originalFlag;
});

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

  it("preserves a real raw_di / di_tilde / distance of exactly 0 instead of coercing it to null", () => {
    const result = evaluateOrderbookDirectionalGate("LONG", {
      is_level_proximate: true,
      gate_action: "NO_ACTION",
      raw_di: 0,
      di_tilde: 0,
      distance_bps: 0,
      nearest_level_price: 0,
    });
    expect(result.rawDi).toBe(0);
    expect(result.diTilde).toBe(0);
    expect(result.distanceBps).toBe(0);
  });

  it("keeps a missing raw_di / di_tilde as null (unavailable), not 0", () => {
    const result = evaluateOrderbookDirectionalGate("LONG", {
      is_level_proximate: true,
      gate_action: "NO_ACTION",
      raw_di: null,
      di_tilde: undefined,
    });
    expect(result.rawDi).toBeNull();
    expect(result.diTilde).toBeNull();
  });
});

/**
 * `resolveConfluenceSignalFromDepth` negates the causally standardised DI into `di_tilde` before
 * the directional read. `apps/ml/run_orderbook01_oos.py` (the frozen OOS validator this gate
 * implements) applies `di_tilde = -di` UNIFORMLY to Tier 1 (SWING/ITH/ITL/SESSION) and Tier 2
 * (PDL) alike. These tests pin the sign convention for both tiers so a reintroduced asymmetry
 * fails loudly.
 */
describe("resolveConfluenceSignalFromDepth DI_tilde sign convention", () => {
  // History centred on -0.3 (the typical sell-heavy day). Sell-dominant depth (raw -0.6) is MORE
  // sell-heavy than usual => detrended -0.3 => di_tilde = +0.3.
  const history = flatHistory(-0.3);

  const sellDominantDepth: DepthFrameLevelData = {
    totalBuyQty: 200,
    totalSellQty: 800,
    bidPrice: [100],
    bidQty: [200],
    askPrice: [101],
    askQty: [800],
  };

  // raw +0.6 against a -0.3 baseline => detrended +0.9 => di_tilde = -0.9.
  const buyDominantDepth: DepthFrameLevelData = {
    totalBuyQty: 800,
    totalSellQty: 200,
    bidPrice: [100],
    bidQty: [800],
    askPrice: [101],
    askQty: [200],
  };

  it("negates the detrended DI for a Tier 1 level (SESSION_HIGH): sell-heavy depth flags BEARISH_REJECTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
      priorMinuteDi: history,
    });
    expect(signal.raw_di).toBeCloseTo(-0.6, 10);
    expect(signal.di_tilde).toBeCloseTo(0.3, 10);
    expect(signal.directional_bias).toBe("BEARISH_REJECTION");
    expect(signal.gate_action).toBe("BUY_PUT_OR_SHORT");
    expect(signal.di_status).toBe("OK");
  });

  it("negates the detrended DI for a Tier 2 level (PDL): sell-heavy depth flags BEARISH_SWEEP, not NO_ACTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "PDL",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
      priorMinuteDi: history,
    });
    expect(signal.raw_di).toBeCloseTo(-0.6, 10);
    expect(signal.di_tilde).toBeCloseTo(0.3, 10);
    expect(signal.directional_bias).toBe("BEARISH_SWEEP");
    expect(signal.gate_action).toBe("BUY_PUT_OR_SHORT");
  });

  it("Tier 1 and Tier 2 agree in sign on the same depth snapshot (uniform negation)", () => {
    const tier1Signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "ITH",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: buyDominantDepth,
      priorMinuteDi: history,
    });
    const tier2Signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "PDL",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: buyDominantDepth,
      priorMinuteDi: history,
    });
    expect(tier1Signal.raw_di).toBeCloseTo(0.6, 10);
    expect(tier2Signal.raw_di).toBeCloseTo(0.6, 10);
    expect(tier1Signal.di_tilde).toBeCloseTo(-0.9, 10);
    expect(tier2Signal.di_tilde).toBeCloseTo(-0.9, 10);
    expect(tier1Signal.gate_action).toBe("NO_ACTION");
    expect(tier2Signal.gate_action).toBe("NO_ACTION");
  });

  it("negates the detrended DI for a Tier 1 LOW level: sell-heavy depth flags BULLISH_REJECTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_LOW",
      nearestLevelPrice: 100.5,
      distanceBps: 5,
      depth: sellDominantDepth,
      priorMinuteDi: history,
    });
    expect(signal.di_tilde).toBeCloseTo(0.3, 10);
    expect(signal.directional_bias).toBe("BULLISH_REJECTION");
    expect(signal.gate_action).toBe("BUY_CALL_OR_LONG");
  });
});

describe("DI availability: unavailable is null, never 0", () => {
  const depth = (buy: number | null | undefined, sell: number | null | undefined): DepthFrameLevelData => ({
    totalBuyQty: buy,
    totalSellQty: sell,
  });

  it("calculateDecayingDepthImbalance returns null rawDi for a missing or empty frame", () => {
    expect(calculateDecayingDepthImbalance(depth(null, null)).rawDi).toBeNull();
    expect(calculateDecayingDepthImbalance(depth(undefined, undefined)).rawDi).toBeNull();
    expect(calculateDecayingDepthImbalance(depth(0, 0)).rawDi).toBeNull();
    expect(calculateDecayingDepthImbalance({}).rawDi).toBeNull();
  });

  it("a genuinely balanced book is a real 0, distinct from unavailable", () => {
    expect(calculateDecayingDepthImbalance(depth(500, 500)).rawDi).toBe(0);
  });

  it("returns di_tilde=null / NO_ACTION when the depth frame is missing", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100,
      distanceBps: 2,
      depth: depth(0, 0),
      priorMinuteDi: flatHistory(-0.3),
    });
    expect(signal.raw_di).toBeNull();
    expect(signal.di_tilde).toBeNull();
    expect(signal.gate_action).toBe("NO_ACTION");
    expect(signal.di_status).toBe("UNAVAILABLE_DEPTH");
  });

  it("returns di_tilde=null when there is not enough causal history (no raw-sign fallback)", () => {
    const sellHeavy = depth(100, 900);
    const none = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100,
      distanceBps: 2,
      depth: sellHeavy,
    });
    expect(none.di_tilde).toBeNull();
    expect(none.gate_action).toBe("NO_ACTION");
    expect(none.di_status).toBe("UNAVAILABLE_HISTORY");

    const short = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100,
      distanceBps: 2,
      depth: sellHeavy,
      priorMinuteDi: flatHistory(-0.3, DI_STANDARDISATION_MIN_HISTORY_MINUTES - 1),
    });
    expect(short.di_tilde).toBeNull();
    expect(short.di_status).toBe("UNAVAILABLE_HISTORY");
  });

  it("an exactly-at-baseline DI yields a real di_tilde of 0 (not null) and NO_ACTION", () => {
    const signal = resolveConfluenceSignalFromDepth({
      nearestLevelType: "SESSION_HIGH",
      nearestLevelPrice: 100,
      distanceBps: 2,
      depth: depth(375, 625), // raw DI = -0.25 (binary-exact)
      priorMinuteDi: flatHistory(-0.25),
    });
    expect(signal.di_tilde).toBeCloseTo(0, 12);
    expect(signal.di_status).toBe("OK");
    expect(signal.gate_action).toBe("NO_ACTION");
  });

  it("causalStandardiseDi ignores non-finite history entries", () => {
    const result = causalStandardiseDi(0.1, [...flatHistory(0.0, 12), Number.NaN, Number.POSITIVE_INFINITY]);
    expect(result.status).toBe("OK");
    expect(result.historyCount).toBe(12);
    expect(result.detrendedDi).toBeCloseTo(0.1, 12);
  });
});

/**
 * The audited defect: on most days raw DI is almost a per-day constant (e.g. always negative), so
 * `di_tilde = -rawDi > 0` was true for the whole day. The standardised signal must vary.
 */
describe("causal within-day DI standardisation on a constantly-negative day", () => {
  const dayStart = Date.parse("2026-09-14T04:00:00Z");
  const minute = 60_000;

  // One frame per 10 s for 90 minutes; raw DI is ALWAYS negative (-0.45 .. -0.15), slowly drifting
  // plus an alternating wobble, like the audited days (mean DI -0.15 to -0.41, ~0-2% positive).
  const frames = Array.from({ length: 540 }, (_, i) => {
    const t = dayStart + i * 10_000;
    const drift = -0.30 + 0.12 * Math.sin(i / 45);
    const wobble = 0.05 * (Math.floor(i / 6) % 2 === 0 ? 1 : -1);
    return { receivedAt: new Date(t), rawDi: drift + wobble };
  });

  it("the fixture really is a constant-sign raw-DI day", () => {
    expect(frames.every((f) => f.rawDi! < 0)).toBe(true);
  });

  it("raw sign is constant, standardised sign is not", () => {
    const rawTildeSigns = new Set<boolean>();
    const stdTildeSigns = new Set<boolean>();
    let published = 0;
    for (let i = 0; i < frames.length; i += 6) {
      const frame = frames[i]!;
      const history = trailingMinuteDiSamples(frames, frame.receivedAt);
      const standardised = causalStandardiseDi(frame.rawDi, history);
      rawTildeSigns.add(-frame.rawDi! > 0);
      if (standardised.status === "OK") {
        published += 1;
        stdTildeSigns.add(-standardised.detrendedDi! > 0);
      }
    }
    expect(rawTildeSigns.size).toBe(1); // the defect: di_tilde > 0 for the entire day
    expect(published).toBeGreaterThan(30);
    expect(stdTildeSigns.size).toBe(2); // the fix: both signs occur
  });

  it("is unavailable (null) during the first minutes of the day, before enough history exists", () => {
    const early = frames[12]!; // 2 minutes in
    const history = trailingMinuteDiSamples(frames, early.receivedAt);
    expect(causalStandardiseDi(early.rawDi, history).status).toBe("UNAVAILABLE_HISTORY");
  });

  it("only uses data strictly before the current minute (causal)", () => {
    const asOf = new Date(dayStart + 25 * minute + 30_000);
    const history = trailingMinuteDiSamples(frames, asOf);
    // 25 complete prior minutes available (0..24); the in-progress minute 25 is excluded.
    expect(history.length).toBe(25);

    // Poisoning every frame at/after the as-of minute must not change the history.
    const poisoned = frames.map((f) =>
      f.receivedAt.getTime() >= dayStart + 25 * minute ? { ...f, rawDi: 99 } : f,
    );
    expect(trailingMinuteDiSamples(poisoned, asOf)).toEqual(history);
  });

  it("caps the history at the trailing window and takes the last frame of each minute", () => {
    const asOf = new Date(dayStart + 85 * minute);
    const history = trailingMinuteDiSamples(frames, asOf, 30);
    expect(history.length).toBe(30);
    const lastFrameOfMinute84 = [...frames].reverse().find((f) => f.receivedAt.getTime() < dayStart + 85 * minute)!;
    expect(history[history.length - 1]).toBe(lastFrameOfMinute84.rawDi);
  });

  it("skips null-DI frames instead of zero-filling them", () => {
    const withGaps = frames.map((f, i) => (i % 2 === 0 ? { ...f, rawDi: null } : f));
    const history = trailingMinuteDiSamples(withGaps, new Date(dayStart + 25 * minute));
    expect(history.every((v) => v < 0)).toBe(true); // a zero-fill would inject 0s (positive vs these)
  });
});

describe("applyOrderbookGateToProposal kill switch (ORDERBOOK01_LIVE_GATE_ENABLED)", () => {
  const passSignal = {
    is_level_proximate: true,
    gate_action: "BUY_CALL_OR_LONG",
    directional_bias: "BULLISH_REJECTION",
  };
  const blockSignal = {
    is_level_proximate: true,
    gate_action: "BUY_PUT_OR_SHORT",
    directional_bias: "BEARISH_REJECTION",
  };

  describe("switch OFF (default)", () => {
    beforeEach(() => {
      delete process.env.ORDERBOOK01_LIVE_GATE_ENABLED;
    });

    it("does NOT lower confidence on a BLOCK verdict, but records the shadow verdict", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63, side: "LONG" }), blockSignal);
      expect(updated.confidence).toBe(0.63);
      expect(updated.reasoning).toEqual([]);
      expect(updated.evidence.orderbookGate).toMatchObject({
        gateStatus: "BLOCK",
        shadowVerdict: "BLOCKED",
        confidenceAdjustment: -0.30,
        liveGateEnabled: false,
        adjustmentApplied: false,
      });
    });

    it("does NOT raise confidence on a PASS verdict, but records the shadow verdict", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63, side: "LONG" }), passSignal);
      expect(updated.confidence).toBe(0.63);
      expect(updated.evidence.orderbookGate).toMatchObject({
        gateStatus: "PASS",
        shadowVerdict: "ALLOWED",
        liveGateEnabled: false,
        adjustmentApplied: false,
      });
    });

    it.each(["TRUE", "1", "yes", "", "false"])("treats %j as OFF (exact string 'true' only)", (value) => {
      process.env.ORDERBOOK01_LIVE_GATE_ENABLED = value;
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63, side: "LONG" }), blockSignal);
      expect(updated.confidence).toBe(0.63);
    });

    it("a BLOCK can no longer push a >=0.6 proposal below the options-entry confidence floor", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.62, side: "LONG" }), blockSignal);
      expect(updated.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("switch ON", () => {
    beforeEach(() => {
      process.env.ORDERBOOK01_LIVE_GATE_ENABLED = "true";
    });

    it("adds a fractional adjustment on PASS, staying within [0, 1]", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63, side: "LONG" }), passSignal);
      expect(updated.confidence).toBeCloseTo(0.78, 10);
      expect(updated.reasoning.length).toBe(1);
      expect(updated.evidence.orderbookGate).toMatchObject({ liveGateEnabled: true, adjustmentApplied: true });
    });

    it("subtracts a fractional adjustment on BLOCK, clamped at 0 rather than going deeply negative", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.2, side: "LONG" }), blockSignal);
      expect(updated.confidence).toBe(0);
    });

    it("subtracts 0.30 on BLOCK for a normal confidence", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.7, side: "LONG" }), blockSignal);
      expect(updated.confidence).toBeCloseTo(0.4, 10);
    });

    it("never lets an adjustment push confidence above 1, even on a high-confidence PASS", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.95, side: "LONG" }), passSignal);
      expect(updated.confidence).toBeLessThanOrEqual(1);
      expect(updated.confidence).toBeCloseTo(1, 10);
    });

    it("leaves confidence untouched on NEUTRAL, only attaching shadow evidence", () => {
      const updated = applyOrderbookGateToProposal(proposal({ confidence: 0.63 }), null);
      expect(updated.confidence).toBe(0.63);
      expect(updated.evidence.orderbookGate).toMatchObject({ gateStatus: "NEUTRAL", shadowVerdict: "NEUTRAL" });
    });
  });
});
