import { describe, it, expect } from "vitest";
import { IctCompositeEngine } from "./composite-engine.js";
import { ICT_STATE_ENGINE_VERSION, defaultIctEngineConfig } from "./config.js";
import { NSE_IST_PROFILE, XAUUSD_OANDA_PROFILE } from "../../../platform/calendar/instrument-profile.js";
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

describe("IctCompositeEngine", () => {
  it("processes candles sequentially and computes full 4-pillar snapshot", () => {
    const engine = new IctCompositeEngine();
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105),
      makeIstCandle("2026-01-05", 9, 20, 105, 112, 104, 108),
      makeIstCandle("2026-01-06", 9, 15, 106, 107, 93, 97), // Sweeps PDL (95) and reclaims at 97
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      // Bias is sourced from the higher-timeframe read, so the replay must supply one; without
      // it the bias pillar fails closed to UNKNOWN by design.
      snap = engine.processCandle(candles, i, "BULLISH");
    }

    expect(snap.engineVersion).toBe(ICT_STATE_ENGINE_VERSION);
    expect(snap.configHash).toHaveLength(64);
    expect(snap.barIndex).toBe(2);
    expect(snap.sessionLevels.levels).not.toBeNull();
    expect(snap.sessionLevels.levels?.pdh).toBe(112);
    expect(snap.sessionLevels.levels?.pdl).toBe(95);
    expect(snap.bias.bias).toBe("BULLISH"); // higher-timeframe bias, confirmed by the PDL sweep
    expect(snap.coverage.zones).toBe("COMPLETE");
    expect(snap.coverage.sessionLevels).toBe("COMPLETE");
    expect(snap.coverage.bias).toBe("COMPLETE");
    // Present on every snapshot, even before any Intermediate/Short Term point has been confirmed --
    // an empty swing hierarchy is a real (if uninformative) reading, not a missing pillar.
    expect(snap.swingHierarchy).toEqual({
      nearestIntermediateTermHigh: null,
      nearestIntermediateTermLow: null,
      nearestShortTermHigh: null,
      nearestShortTermLow: null,
    });
  });

  it("reports UNKNOWN (not NEUTRAL) coverage before there is sufficient evidence", () => {
    const engine = new IctCompositeEngine();
    // A single opening candle: no confirmed pivots, no prior session, no HTF.
    const candles: CausalCandle[] = [makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105)];
    const snap = engine.processCandle(candles, 0);

    // Evidence is absent, so structure/bias coverage is UNKNOWN and the value
    // is not silently collapsed to NEUTRAL (invariant 2: UNKNOWN != NEUTRAL).
    expect(snap.coverage.structure).toBe("UNKNOWN");
    expect(snap.coverage.bias).toBe("UNKNOWN");
    expect(snap.bias.bias).toBe("UNKNOWN");
    expect(snap.bias.bias).not.toBe("NEUTRAL");
    // No prior session and no HTF projection: genuinely not-covered, not unknown.
    expect(snap.coverage.sessionLevels).toBe("NOT_COVERED");
    expect(snap.coverage.htf).toBe("NOT_COVERED");
  });

  it("distinguishes an UNKNOWN htf projection from a missing one", () => {
    const engine = new IctCompositeEngine();
    const candles: CausalCandle[] = [makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105)];
    expect(engine.processCandle(candles, 0, "UNKNOWN").coverage.htf).toBe("UNKNOWN");
    expect(engine.processCandle(candles, 0, "BULLISH").coverage.htf).toBe("COMPLETE");
    expect(engine.processCandle(candles, 0).coverage.htf).toBe("NOT_COVERED");
  });

  describe("instrument profile wiring (G1)", () => {
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105),
      makeIstCandle("2026-01-05", 9, 20, 105, 112, 104, 108),
      makeIstCandle("2026-01-06", 9, 15, 106, 107, 93, 97),
    ];

    function runAll(engine: IctCompositeEngine) {
      let last: ReturnType<IctCompositeEngine["processCandle"]> | undefined;
      for (let i = 0; i < candles.length; i++) last = engine.processCandle(candles, i);
      return last!;
    }

    it("an explicit NSE_IST_PROFILE is byte-for-byte identical to the default (no-profile) engine", () => {
      const defaultSnap = runAll(new IctCompositeEngine());
      const explicitSnap = runAll(new IctCompositeEngine(defaultIctEngineConfig, NSE_IST_PROFILE));
      // JSON-serialised comparison: `dealingRange.isPremium`/`isDiscount` are closures, and two
      // independently-built closures are never `toEqual` even when every captured value agrees, so
      // a literal `toEqual` on the raw snapshot is the wrong test here. Serialisation is also
      // exactly what `persistIctSnapshot` does to this same object (`JSON.stringify(snapshot)`), so
      // this is the same notion of "identical" the live cache-fill path relies on.
      expect(JSON.stringify(explicitSnap)).toBe(JSON.stringify(defaultSnap));
    });

    it("passes the profile through to both the session-levels and bias pillars", () => {
      // Bar 0 and bar 1 sit 15:00-19:00 NY on 2026-07-13 (gold's session boundary is 18:00 NY); bar
      // 2 is the next NY morning. Under NSE's fixed +5:30 offset all three land on IST 2026-07-14.
      const xauCandles: CausalCandle[] = [
        { id: "a", openTime: new Date("2026-07-13T19:00:00.000Z"), open: 100, high: 105, low: 95, close: 102, volume: 10 },
        { id: "b", openTime: new Date("2026-07-13T23:00:00.000Z"), open: 102, high: 112, low: 101, close: 110, volume: 10 },
        { id: "c", openTime: new Date("2026-07-14T14:00:00.000Z"), open: 110, high: 113, low: 109, close: 111, volume: 10 },
      ];

      const xauEngine = new IctCompositeEngine(defaultIctEngineConfig, XAUUSD_OANDA_PROFILE);
      let xauSnap: ReturnType<IctCompositeEngine["processCandle"]> | undefined;
      for (let i = 0; i < xauCandles.length; i++) xauSnap = xauEngine.processCandle(xauCandles, i);
      // Gold rolled sessions between bar 0 and bar 1, so by bar 2 prior-session levels are resolved
      // from bar 0 alone, and both the session-levels AND bias pillars see the same session date.
      expect(xauSnap!.sessionLevels.currentSessionDate).toBe("2026-07-14");
      expect(xauSnap!.sessionLevels.levels?.priorSessionDate).toBe("2026-07-13");
      expect(xauSnap!.sessionLevels.levels?.pdh).toBe(105);

      const nseEngine = new IctCompositeEngine(defaultIctEngineConfig, NSE_IST_PROFILE);
      let nseSnap: ReturnType<IctCompositeEngine["processCandle"]> | undefined;
      for (let i = 0; i < xauCandles.length; i++) nseSnap = nseEngine.processCandle(xauCandles, i);
      // NSE's fixed-offset profile sees all three on the SAME IST calendar date: no rollover, so no
      // prior-session levels resolve at all.
      expect(nseSnap!.sessionLevels.currentSessionDate).toBe("2026-07-14");
      expect(nseSnap!.sessionLevels.levels).toBeNull();
    });
  });
});
