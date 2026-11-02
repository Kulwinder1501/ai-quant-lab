import { describe, expect, it } from "vitest";
import {
  defaultIctStructureStrategyConfiguration,
  IctStructureStrategy,
  type IctStructureStrategyConfiguration,
} from "./ict-structure-strategy.js";
import {
  firstSweepMssGate,
  formatSweepMssGateLine,
  summariseSweepMssGates,
  type SweepMssBar,
  type SweepMssGate,
} from "./ict-sweep-mss-gates.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";

// The strategy's own fixture (ict-structure-strategy.mss.test.ts): a bullish shift, leg 100 -> 140, ATR 5, OTE band 108.4-115.2.
const ATR = 5;
function snapshot(overrides: Record<string, unknown> = {}, direction: "BULLISH" | "BEARISH" = "BULLISH"): IctStateCompositeSnapshot {
  const bullish = direction === "BULLISH";
  return {
    atr14: ATR,
    htfBias: direction,
    engineVersion: "test",
    configHash: "test",
    coverage: { structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE", sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE" },
    bias: { bias: direction, dailyTemplate: "OLHC", dealingRange: null },
    structure: { trend: direction },
    zones: { activeObs: [], activeFvgs: [] },
    sessionLevels: { levels: { pdh: 200, pdl: 50 }, lastSweepEvent: null },
    liquidity: { alignmentStatus: bullish ? "ALIGNED_LONG" : "ALIGNED_SHORT", primaryTarget: null, intermediateTarget: null, invalidationLevel: null },
    mss: {
      direction,
      brokenLevel: bullish ? 110 : 190,
      brokenPivotTime: new Date("2026-01-06T03:00:00.000Z"),
      sweepBarIndex: 10,
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

const OPEN_TIME = new Date("2026-01-06T04:00:00.000Z");
const TAP: SweepMssBar = { open: 114.5, high: 117, low: 114, close: 116, openTime: OPEN_TIME };

function contextFor(ict: IctStateCompositeSnapshot, bar: SweepMssBar): StrategyMarketContext {
  return {
    candle: {
      id: "c-1", instrumentId: "inst-1", timeframe: "15m", openTime: bar.openTime,
      closeTime: new Date(bar.openTime.getTime() + 15 * 60_000), volume: 1000, tickSize: 0.05,
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    },
    indicators: [], patterns: [], priceActionEvents: [], ictSnapshot: ict,
  };
}

const RETRACE: IctStructureStrategyConfiguration = { ...defaultIctStructureStrategyConfiguration, entryModel: "SWEEP_MSS_RETRACE" };
const LIMIT: IctStructureStrategyConfiguration = { ...defaultIctStructureStrategyConfiguration, entryModel: "SWEEP_MSS_LIMIT" };

function withCoverage(pillar: string): IctStateCompositeSnapshot {
  const snap = snapshot() as unknown as { coverage: Record<string, string> };
  snap.coverage = { ...snap.coverage, [pillar]: "UNKNOWN" };
  return snap as unknown as IctStateCompositeSnapshot;
}

interface Scenario {
  readonly name: string;
  readonly ict: IctStateCompositeSnapshot;
  readonly bar: SweepMssBar;
  readonly config: IctStructureStrategyConfiguration;
  readonly expected: SweepMssGate;
}

const scenarios: Scenario[] = [
  { name: "taps and holds the band", ict: snapshot(), bar: TAP, config: RETRACE, expected: "WOULD_FIRE" },
  { name: "bearish mirror", ict: snapshot({}, "BEARISH"), bar: { open: 188, high: 189, low: 186, close: 187, openTime: OPEN_TIME }, config: RETRACE, expected: "WOULD_FIRE" },
  { name: "limit model before the retrace", ict: snapshot({ barsSinceBreak: 0 }), bar: { open: 130, high: 135, low: 129, close: 133, openTime: OPEN_TIME }, config: LIMIT, expected: "WOULD_FIRE" },
  { name: "limit model after price went through the sweet spot", ict: snapshot(), bar: { open: 113, high: 114, low: 110, close: 111, openTime: OPEN_TIME }, config: LIMIT, expected: "ALREADY_RETRACED" },
  { name: "no shift", ict: { ...snapshot(), mss: null } as unknown as IctStateCompositeSnapshot, bar: TAP, config: RETRACE, expected: "NO_SHIFT" },
  { name: "bias missing", ict: withCoverage("bias"), bar: TAP, config: RETRACE, expected: "COVERAGE_INCOMPLETE" },
  { name: "htf missing", ict: withCoverage("htf"), bar: TAP, config: RETRACE, expected: "COVERAGE_INCOMPLETE" },
  { name: "structure missing", ict: withCoverage("structure"), bar: TAP, config: RETRACE, expected: "COVERAGE_INCOMPLETE" },
  { name: "no ATR", ict: { ...snapshot(), atr14: null } as unknown as IctStateCompositeSnapshot, bar: TAP, config: RETRACE, expected: "NO_ATR" },
  { name: "daily bias opposes", ict: { ...snapshot(), bias: { bias: "BEARISH", dailyTemplate: "OLHC", dealingRange: null } } as unknown as IctStateCompositeSnapshot, bar: TAP, config: RETRACE, expected: "BIAS_OPPOSES_SHIFT" },
  { name: "HTF bias opposes", ict: { ...snapshot(), htfBias: "BEARISH" } as unknown as IctStateCompositeSnapshot, bar: TAP, config: RETRACE, expected: "BIAS_OPPOSES_SHIFT" },
  { name: "shift too old", ict: snapshot({ barsSinceBreak: 13 }), bar: TAP, config: RETRACE, expected: "SHIFT_TOO_OLD" },
  { name: "outside killzone when required", ict: snapshot(), bar: { ...TAP, openTime: new Date("2026-01-06T06:30:00.000Z") }, config: { ...RETRACE, requireKillzone: true }, expected: "OUTSIDE_KILLZONE" },
  { name: "leg too small", ict: snapshot({ legStart: 100, legEnd: 103 }), bar: TAP, config: RETRACE, expected: "LEG_TOO_SMALL" },
  { name: "break just printed", ict: snapshot({ barsSinceBreak: 0 }), bar: TAP, config: RETRACE, expected: "NO_BAR_AFTER_BREAK" },
  { name: "has not retraced into the band", ict: snapshot(), bar: { open: 125, high: 128, low: 124, close: 127, openTime: OPEN_TIME }, config: RETRACE, expected: "NOT_TAPPED_AND_HELD" },
  { name: "closes through the far edge", ict: snapshot(), bar: { open: 112, high: 113, low: 105, close: 106, openTime: OPEN_TIME }, config: RETRACE, expected: "NOT_TAPPED_AND_HELD" },
  { name: "taps the band but closes down", ict: snapshot(), bar: { open: 116, high: 117, low: 114, close: 114.5, openTime: OPEN_TIME }, config: RETRACE, expected: "NOT_TAPPED_AND_HELD" },
  // Leg 100 -> 200 puts the OTE band at 121-138; entering at 136.5 leaves the stop at 99.25, 7.45 ATR away, over the 6 ATR cap.
  { name: "stop too far from the entry", ict: snapshot({ legStart: 100, legEnd: 200 }), bar: { open: 134, high: 138, low: 133, close: 136.5, openTime: OPEN_TIME }, config: RETRACE, expected: "RISK_OUT_OF_RANGE" },
  { name: "risk-reward below the floor", ict: snapshot(), bar: TAP, config: { ...RETRACE, minimumRiskReward: 5 }, expected: "RISK_REWARD_TOO_LOW" },
];

describe("firstSweepMssGate agrees with IctStructureStrategy", () => {
  const strategy = new IctStructureStrategy();

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      expect(firstSweepMssGate(scenario.ict, scenario.bar, scenario.config)).toBe(scenario.expected);
      const proposed = strategy.evaluate(contextFor(scenario.ict, scenario.bar), scenario.config as unknown as Record<string, unknown>).length > 0;
      expect(proposed).toBe(scenario.expected === "WOULD_FIRE");
    });
  }
});

describe("sweep -> MSS gate summary", () => {
  const empty = { ideas: 0, trades: 0, strategyErrorRuns: 0 };

  it("counts bars by their first blocking gate, most common first", () => {
    const summary = summariseSweepMssGates(["NO_SHIFT", "NO_SHIFT", "NO_SHIFT", "SHIFT_TOO_OLD", "WOULD_FIRE"], empty);
    expect(summary.bars).toBe(5);
    expect(summary.gates[0]).toEqual({ gate: "NO_SHIFT", bars: 3 });
    expect(summary.barsWithShift).toBe(2);
    expect(summary.wouldFire).toBe(1);
  });

  it("states the reason in the daily line", () => {
    const line = formatSweepMssGateLine("2026-11-02", "BANKNIFTY/5m", summariseSweepMssGates(["NO_SHIFT", "NO_SHIFT", "NOT_TAPPED_AND_HELD", "NO_SHIFT"], empty));
    expect(line).toContain("75% no market structure shift");
    expect(line).toContain("25% retrace has not tapped and held the OTE band");
    expect(line).toContain("shift live on 1");
    expect(line).not.toContain("alignment");
  });

  it("flags a setup that would have fired with no idea raised", () => {
    const line = formatSweepMssGateLine("2026-11-02", "BANKNIFTY/5m", summariseSweepMssGates(["WOULD_FIRE", "NO_SHIFT"], empty));
    expect(line).toContain("SETUP WOULD HAVE FIRED BUT NO IDEA WAS RAISED");
  });

  it("does not raise that flag when an idea exists", () => {
    const line = formatSweepMssGateLine("2026-11-02", "BANKNIFTY/5m", summariseSweepMssGates(["WOULD_FIRE"], { ideas: 1, trades: 0, strategyErrorRuns: 0 }));
    expect(line).not.toContain("NO IDEA WAS RAISED");
  });

  it("flags strategy errors, which mean the funnel is not what the bot saw", () => {
    const line = formatSweepMssGateLine("2026-11-02", "BANKNIFTY/5m", summariseSweepMssGates(["NO_SHIFT"], { ideas: 0, trades: 0, strategyErrorRuns: 2 }));
    expect(line).toContain("STRATEGY ERRORS in 2 bot run(s)");
  });

  it("says so when no bars were recorded", () => {
    expect(formatSweepMssGateLine("2026-11-02", "NIFTY50/15m", summariseSweepMssGates([], empty))).toContain("no bars recorded");
  });
});
