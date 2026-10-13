import { describe, expect, it } from "vitest";
import { COUNTER_BIAS_VARIANT, evaluateCounterBiasVariant } from "./ict-shadow-variant.js";
import { IctStructureStrategy, ictStructureStrategyRegistration } from "./ict-structure-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";

const ATR = 5;

function snapshot(options: {
  mss: "BULLISH" | "BEARISH" | null;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  htfBias: "BULLISH" | "BEARISH" | null;
}): IctStateCompositeSnapshot {
  const bullish = options.mss === "BULLISH";
  return {
    atr14: ATR,
    htfBias: options.htfBias,
    engineVersion: "test",
    configHash: "test",
    coverage: { structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE", sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE" },
    bias: { bias: options.bias, dailyTemplate: "OLHC", dealingRange: null },
    structure: { trend: options.bias },
    zones: { activeObs: [], activeFvgs: [] },
    sessionLevels: { levels: { pdh: 200, pdl: 50 }, lastSweepEvent: null },
    liquidity: { alignmentStatus: "BLOCKED_BIAS_STRUCTURE_DISAGREEMENT", primaryTarget: null, intermediateTarget: null, invalidationLevel: null },
    mss: options.mss === null ? null : {
      direction: options.mss,
      brokenLevel: bullish ? 110 : 190,
      brokenPivotTime: new Date("2026-01-06T03:00:00.000Z"),
      sweepBarIndex: 10,
      // Bullish: leg 100 -> 140, OTE band 108.4-115.2. Bearish: leg 200 -> 160, band 184.8-191.6.
      legStart: bullish ? 100 : 200,
      legEnd: bullish ? 140 : 160,
      breakBarIndex: 12,
      breakBarTime: new Date("2026-01-06T03:30:00.000Z"),
      displacementBodyAtr: 1.6,
      hasFvg: true,
      barsSinceBreak: 3,
      sweptKind: "SWING",
      availableAt: 0,
    },
  } as unknown as IctStateCompositeSnapshot;
}

// Taps the bullish band and closes as a bullish reaction candle.
const BULLISH_TAP = { open: 114.5, high: 117, low: 114, close: 116 };

function contextFor(ict: IctStateCompositeSnapshot, bar = BULLISH_TAP): StrategyMarketContext {
  return {
    candle: {
      id: "c-1", instrumentId: "inst-1", timeframe: "15m",
      openTime: new Date("2026-01-06T04:00:00.000Z"), closeTime: new Date("2026-01-06T04:15:00.000Z"),
      volume: 1000, tickSize: 0.05, ...bar,
    },
    indicators: [], patterns: [], priceActionEvents: [], ictSnapshot: ict,
  };
}

describe("evaluateCounterBiasVariant", () => {
  it("proposes the counter-bias setup the live strategy skips, and says so", () => {
    const ict = snapshot({ mss: "BULLISH", bias: "BEARISH", htfBias: "BEARISH" });
    const live = new IctStructureStrategy().evaluate(contextFor(ict), ictStructureStrategyRegistration.configuration);
    expect(live).toHaveLength(0);

    const [signal] = evaluateCounterBiasVariant(contextFor(ict));
    expect(signal).toBeDefined();
    expect(signal!.variant).toBe(COUNTER_BIAS_VARIANT);
    expect(signal!.side).toBe("LONG");
    expect(signal!.bias).toBe("BEARISH");
    expect(signal!.htfBias).toBe("BEARISH");
    expect(signal!.biasAligned).toBe(false);
    expect(signal!.htfAligned).toBe(false);
    expect(signal!.liveWouldFire).toBe(false);
  });

  it("marks an aligned setup as one the live strategy also proposes, with identical geometry", () => {
    const ict = snapshot({ mss: "BULLISH", bias: "BULLISH", htfBias: "BULLISH" });
    const [live] = new IctStructureStrategy().evaluate(contextFor(ict), ictStructureStrategyRegistration.configuration);
    const [signal] = evaluateCounterBiasVariant(contextFor(ict));
    expect(live).toBeDefined();
    expect(signal!.biasAligned).toBe(true);
    expect(signal!.htfAligned).toBe(true);
    expect(signal!.liveWouldFire).toBe(true);
    expect([signal!.entryPrice, signal!.stopLoss, signal!.targetPrice]).toEqual([live!.entryPrice, live!.stopLoss, live!.targetPrice]);
  });

  it("treats an absent higher-timeframe bias as aligned, as the live gate does", () => {
    const ict = snapshot({ mss: "BULLISH", bias: "BULLISH", htfBias: null });
    const [signal] = evaluateCounterBiasVariant(contextFor(ict));
    expect(signal!.htfAligned).toBe(true);
    expect(signal!.htfBias).toBeNull();
  });

  it("lifts only the bias gates: a bar that has not retraced into the band still yields nothing", () => {
    const ict = snapshot({ mss: "BULLISH", bias: "BEARISH", htfBias: "BEARISH" });
    expect(evaluateCounterBiasVariant(contextFor(ict, { open: 125, high: 128, low: 124, close: 127 }))).toHaveLength(0);
  });

  it("yields nothing without a shift or without a snapshot", () => {
    expect(evaluateCounterBiasVariant(contextFor(snapshot({ mss: null, bias: "BEARISH", htfBias: "BEARISH" })))).toHaveLength(0);
    const bare = { ...contextFor(snapshot({ mss: "BULLISH", bias: "BEARISH", htfBias: null })), ictSnapshot: undefined };
    expect(evaluateCounterBiasVariant(bare as unknown as StrategyMarketContext)).toHaveLength(0);
  });

  it("does not mutate the snapshot the live strategy reads", () => {
    const ict = snapshot({ mss: "BULLISH", bias: "BEARISH", htfBias: "BEARISH" });
    evaluateCounterBiasVariant(contextFor(ict));
    expect(ict.bias.bias).toBe("BEARISH");
    expect(ict.htfBias).toBe("BEARISH");
  });
});
