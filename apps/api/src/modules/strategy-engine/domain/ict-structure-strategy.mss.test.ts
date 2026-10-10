import { describe, expect, it } from "vitest";
import { IctStructureStrategy } from "./ict-structure-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";

const ATR = 5;

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

function mssSnapshot(overrides: Record<string, unknown> = {}, direction: "BULLISH" | "BEARISH" = "BULLISH") {
  const bullish = direction === "BULLISH";
  return {
    atr14: ATR,
    htfBias: direction,
    engineVersion: "test",
    configHash: "test",
    coverage: {
      structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE",
      sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE",
    },
    bias: { bias: direction, dailyTemplate: "OLHC", dealingRange: null },
    structure: { trend: direction },
    zones: { activeObs: [], activeFvgs: [] },
    sessionLevels: { levels: { pdh: 200, pdl: 50 }, lastSweepEvent: null },
    liquidity: {
      alignmentStatus: bullish ? "ALIGNED_LONG" : "ALIGNED_SHORT",
      primaryTarget: { kind: bullish ? "ERL_PDH" : "ERL_PDL", price: bullish ? 150 : 50 },
      intermediateTarget: null,
      invalidationLevel: null,
    },
    mss: {
      direction,
      brokenLevel: bullish ? 110 : 190,
      brokenPivotTime: new Date("2026-01-06T03:00:00.000Z"),
      sweepBarIndex: 10,
      // Bullish: leg 100 -> 140 (OTE band 108.4-115.2, sweet spot 111.8).
      // Bearish: leg 200 -> 160 (OTE band 184.8-191.6, sweet spot 188.2).
      legStart: bullish ? 100 : 200,
      legEnd: bullish ? 140 : 160,
      breakBarIndex: 12,
      breakBarTime: new Date("2026-01-06T03:30:00.000Z"),
      displacementBodyAtr: 1.6,
      hasFvg: true,
      barsSinceBreak: 3,
      sweptKind: "SWING",
      availableAt: 0,
      ...overrides,
    },
  } as unknown as IctStateCompositeSnapshot;
}

function contextFor(snapshot: IctStateCompositeSnapshot, bar: Bar): StrategyMarketContext {
  return {
    candle: {
      id: "c-1",
      instrumentId: "inst-1",
      timeframe: "15m",
      openTime: new Date("2026-01-06T04:00:00.000Z"),
      closeTime: new Date("2026-01-06T04:15:00.000Z"),
      volume: 1000,
      tickSize: 0.05,
      ...bar,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    ictSnapshot: snapshot,
  };
}

const RETRACE = { entryModel: "SWEEP_MSS_RETRACE" };
const LIMIT = { entryModel: "SWEEP_MSS_LIMIT" };

// Taps the 108.4-115.2 band (low 114 <= 115.2), holds it, and closes as a bullish reaction candle.
const TAPPING_BAR: Bar = { open: 114.5, high: 117, low: 114, close: 116 };

describe("IctStructureStrategy sweep -> MSS -> retrace model", () => {
  const strategy = new IctStructureStrategy();

  it("enters at the close of the bar that taps and holds the OTE band, stopped beyond the sweep extreme", () => {
    const [idea] = strategy.evaluate(contextFor(mssSnapshot(), TAPPING_BAR), RETRACE);
    expect(idea).toBeDefined();
    expect(idea.side).toBe("LONG");
    expect(idea.entryPrice).toBe(116);
    // Stop is structural -- 0.15 ATR under the sweep extreme at 100 -- not an ATR multiple of entry.
    expect(idea.stopLoss).toBeCloseTo(100 - 0.15 * ATR, 6);
    // Objective is the leg's far end (140), not the alignment resolver's ERL (150 in this snapshot).
    expect(idea.targetPrice).toBe(140);
    expect(idea.riskReward).toBeCloseTo((140 - 116) / (116 - 99.25), 2);
    expect(idea.evidence.entryModel).toBe("SWEEP_MSS_RETRACE");
  });

  it("does not need the alignment resolver's target or the liquidity/zones coverage a reversal cannot have", () => {
    const reversal = mssSnapshot() as unknown as {
      coverage: Record<string, string>;
      liquidity: { primaryTarget: null; alignmentStatus: string };
      structure: { trend: string };
    };
    reversal.coverage = { ...reversal.coverage, liquidity: "NOT_COVERED", zones: "UNKNOWN", sessionLevels: "NOT_COVERED" };
    reversal.liquidity = { primaryTarget: null, alignmentStatus: "BLOCKED_BIAS_STRUCTURE_DISAGREEMENT" };
    reversal.structure = { trend: "BEARISH" }; // local structure has not caught up with the shift
    const [idea] = strategy.evaluate(contextFor(reversal as unknown as IctStateCompositeSnapshot, TAPPING_BAR), RETRACE);
    expect(idea).toBeDefined();
    expect(idea.side).toBe("LONG");
  });

  it("still fails closed when the bias or higher-timeframe pillar is missing", () => {
    for (const pillar of ["bias", "htf", "structure"]) {
      const snap = mssSnapshot() as unknown as { coverage: Record<string, string> };
      snap.coverage = { ...snap.coverage, [pillar]: "UNKNOWN" };
      expect(strategy.evaluate(contextFor(snap as unknown as IctStateCompositeSnapshot, TAPPING_BAR), RETRACE)).toHaveLength(0);
    }
  });

  it("mirrors for a bearish shift", () => {
    const bar: Bar = { open: 188, high: 189, low: 186, close: 187 }; // taps 184.8-191.6 band, bearish candle
    const [idea] = strategy.evaluate(contextFor(mssSnapshot({}, "BEARISH"), bar), RETRACE);
    expect(idea).toBeDefined();
    expect(idea.side).toBe("SHORT");
    expect(idea.entryPrice).toBe(187);
    expect(idea.stopLoss).toBeCloseTo(200 + 0.15 * ATR, 6);
    expect(idea.targetPrice).toBe(160); // the leg's far end
  });

  it("emits nothing when the bar has not retraced into the band", () => {
    const bar: Bar = { open: 125, high: 128, low: 124, close: 127 };
    expect(strategy.evaluate(contextFor(mssSnapshot(), bar), RETRACE)).toHaveLength(0);
  });

  it("emits nothing when the retrace closes through the far edge of the band (failed retrace)", () => {
    const bar: Bar = { open: 112, high: 113, low: 105, close: 106 };
    expect(strategy.evaluate(contextFor(mssSnapshot(), bar), RETRACE)).toHaveLength(0);
  });

  it("requires a reaction candle in the trade direction", () => {
    const bar: Bar = { open: 116, high: 117, low: 114, close: 114.5 }; // taps the band but closes down
    expect(strategy.evaluate(contextFor(mssSnapshot(), bar), RETRACE)).toHaveLength(0);
  });

  it("needs at least one bar after the break before it can call a retrace", () => {
    const fresh = mssSnapshot({ barsSinceBreak: 0 });
    expect(strategy.evaluate(contextFor(fresh, TAPPING_BAR), RETRACE)).toHaveLength(0);
  });

  it("stops trading a shift once it is older than mssMaxAgeBars", () => {
    const stale = mssSnapshot({ barsSinceBreak: 13 });
    expect(strategy.evaluate(contextFor(stale, TAPPING_BAR), RETRACE)).toHaveLength(0);
  });

  it("refuses a shift that goes against the higher-timeframe bias", () => {
    const against = mssSnapshot() as unknown as { bias: { bias: string }; htfBias: string };
    against.bias = { ...against.bias, bias: "BEARISH" };
    against.htfBias = "BEARISH";
    expect(strategy.evaluate(contextFor(against as unknown as IctStateCompositeSnapshot, TAPPING_BAR), RETRACE)).toHaveLength(0);
  });

  it("emits nothing when no shift is live", () => {
    const none = mssSnapshot() as unknown as { mss: null };
    none.mss = null;
    expect(strategy.evaluate(contextFor(none as unknown as IctStateCompositeSnapshot, TAPPING_BAR), RETRACE)).toHaveLength(0);
  });

  it("caps the objective at maxTargetR when the leg is much longer than the risk", () => {
    const [idea] = strategy.evaluate(contextFor(mssSnapshot(), TAPPING_BAR), { ...RETRACE, maxTargetR: 1.3 });
    // Risk = 116 - 99.25 = 16.75; 1.3R is 137.775, short of the 140 leg extreme, so the cap binds.
    expect(idea.targetPrice).toBeCloseTo(116 + 1.3 * (116 - 99.25), 6);
  });

  it("refuses a leg too small to be worth retracing", () => {
    const tiny = mssSnapshot({ legStart: 100, legEnd: 103 }); // 0.6 ATR
    expect(strategy.evaluate(contextFor(tiny, TAPPING_BAR), RETRACE)).toHaveLength(0);
  });

  it("refuses when the stop would sit inside one bar of noise", () => {
    // Entry 100.2 against a stop at 99.25: risk 0.95 = 0.19 ATR, under the 0.3 ATR floor.
    const snap = mssSnapshot({ legStart: 100, legEnd: 100.2 + 0.7 * 40 });
    const bar: Bar = { open: 100, high: 101, low: 99.9, close: 100.2 };
    expect(strategy.evaluate(contextFor(snap, bar), RETRACE)).toHaveLength(0);
  });

  it("keeps the same setupId for the same shift on every bar, so live can trade it once", () => {
    const a = strategy.evaluate(contextFor(mssSnapshot({ barsSinceBreak: 2 }), TAPPING_BAR), RETRACE)[0];
    const b = strategy.evaluate(contextFor(mssSnapshot({ barsSinceBreak: 5, legEnd: 141 }), TAPPING_BAR), RETRACE)[0];
    expect(a.evidence.setupId).toBeTypeOf("string");
    expect(a.evidence.setupId).toBe(b.evidence.setupId);
  });

  it("is dormant by default: the original alignment model is what runs without the switch", () => {
    // With no entryModel the MSS fields are ignored and this alignment-less snapshot yields nothing.
    expect(strategy.evaluate(contextFor(mssSnapshot(), TAPPING_BAR), {})).toHaveLength(0);
  });
});

describe("IctStructureStrategy SWEEP_MSS_LIMIT", () => {
  const strategy = new IctStructureStrategy();

  it("posts a resting limit at the 70.5% retracement while price has not yet come back", () => {
    const bar: Bar = { open: 130, high: 135, low: 129, close: 133 };
    const [idea] = strategy.evaluate(contextFor(mssSnapshot({ barsSinceBreak: 0 }), bar), LIMIT);
    expect(idea).toBeDefined();
    expect(idea.side).toBe("LONG");
    expect(idea.entryPrice).toBeCloseTo(140 - 0.705 * 40, 6);
    expect(idea.stopLoss).toBeCloseTo(99.25, 6);
    // A limit idea lives longer than a market one: mssLimitExpiryBars (6) x 15m past the close.
    expect(idea.expiresAt!.getTime()).toBe(new Date("2026-01-06T04:15:00.000Z").getTime() + 6 * 15 * 60_000);
  });

  it("posts nothing once price has already retraced through the sweet spot", () => {
    const bar: Bar = { open: 113, high: 114, low: 110, close: 111 };
    expect(strategy.evaluate(contextFor(mssSnapshot(), bar), LIMIT)).toHaveLength(0);
  });
});

describe("requireOte anchored on the displacement leg", () => {
  const strategy = new IctStructureStrategy();

  /** An alignment-model snapshot whose dealing range is far from the MSS leg. */
  function alignmentSnapshot(closeNearLeg: boolean) {
    const snap = mssSnapshot() as unknown as Record<string, any>;
    snap.bias = { bias: "BULLISH", dailyTemplate: "OLHC", dealingRange: { equilibrium: 105, rangeLow: 60, rangeHigh: 160 } };
    snap.zones = {
      activeObs: [{ id: "ob-1", type: "BULLISH", state: "TOUCHED", meanThreshold: closeNearLeg ? 112 : 78, isExtreme: true, isIdmAdjacent: false }],
      activeFvgs: [],
    };
    snap.liquidity = { ...snap.liquidity, invalidationLevel: 90 };
    return snap as unknown as IctStateCompositeSnapshot;
  }

  it("passes when price is inside the leg's OTE band even though the dealing range says otherwise", () => {
    // Dealing range 60-160: its OTE band (62-79% retrace) is 80.9-98.2. Close 112 is outside it, inside the leg's 108.4-115.2.
    const bar: Bar = { open: 111, high: 113, low: 111.5 - 1, close: 112 };
    const ideas = strategy.evaluate(contextFor(alignmentSnapshot(true), bar), { requireOte: true });
    expect(ideas).toHaveLength(1);
  });

  it("falls back to the dealing range when the anchor is switched off", () => {
    const bar: Bar = { open: 111, high: 113, low: 110.5, close: 112 };
    const ideas = strategy.evaluate(contextFor(alignmentSnapshot(true), bar), { requireOte: true, oteAnchor: "DEALING_RANGE" });
    expect(ideas).toHaveLength(0);
  });
});
