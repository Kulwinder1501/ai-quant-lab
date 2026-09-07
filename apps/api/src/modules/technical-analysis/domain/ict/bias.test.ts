import { describe, it, expect } from "vitest";
import { IctBiasTracker } from "./bias.js";
import { IctStructureTracker } from "./structure.js";
import { IctSessionLevelTracker } from "./session-levels.js";
import type { CausalCandle } from "./causal-pivot.js";

function makeIstCandle(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number
): CausalCandle {
  const [y, m, d] = dateStr.split("-").map(Number);
  const istMinutes = hour * 60 + minute;
  const utcMinutes = istMinutes - 330;
  const date = new Date(Date.UTC(y, m - 1, d, 0, utcMinutes));
  return {
    id: `c-${dateStr}-${hour}-${minute}`,
    openTime: date,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

describe("IctBiasTracker", () => {
  it("determines OLHC bullish daily template when session low precedes high", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 105, 95, 98), // Low formed at 95
      makeIstCandle("2026-01-05", 9, 20, 98, 110, 97, 108), // High formed at 110
      makeIstCandle("2026-01-05", 9, 25, 108, 112, 107, 111), // Higher high at 112
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      const sStruct = structTracker.processCandle(candles, i);
      const sSession = sessionTracker.processCandle(candles, i);
      snap = biasTracker.processCandle(candles, i, sStruct, sSession);
    }

    expect(snap.dailyTemplate).toBe("OLHC");
  });

  it("determines OHLC bearish daily template when session high precedes low", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 112, 99, 110), // High formed at 112
      makeIstCandle("2026-01-05", 9, 20, 110, 110, 92, 94), // Low formed at 92
      makeIstCandle("2026-01-05", 9, 25, 94, 96, 90, 91), // Lower low at 90
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      const sStruct = structTracker.processCandle(candles, i);
      const sSession = sessionTracker.processCandle(candles, i);
      snap = biasTracker.processCandle(candles, i, sStruct, sSession);
    }

    expect(snap.dailyTemplate).toBe("OHLC");
  });

  it("prioritizes SSL sweep of PDL into Bullish bias", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105), // Day 1 PDH=110, PDL=95
    ];
    let sStruct = structTracker.processCandle(candles, 0);
    let sSession = sessionTracker.processCandle(candles, 0);
    biasTracker.processCandle(candles, 0, sStruct, sSession);

    // Day 2 Bar 1: Sweeps PDL (95) with Low 93, but closes 97 (SWEEP)
    candles.push(makeIstCandle("2026-01-06", 9, 15, 98, 99, 93, 97));
    sStruct = structTracker.processCandle(candles, 1);
    sSession = sessionTracker.processCandle(candles, 1);
    const snap = biasTracker.processCandle(candles, 1, sStruct, sSession);

    expect(snap.bias).toBe("BULLISH");
    expect(snap.reasons[0]).toContain("Prior Day Low (SSL) swept");
    expect(snap.dealingRange?.equilibrium).toBe(102.5); // (110 + 95)/2
    expect(snap.dealingRange?.isDiscount(97)).toBe(true);
    expect(snap.dealingRange?.isPremium(105)).toBe(true);
  });
});
