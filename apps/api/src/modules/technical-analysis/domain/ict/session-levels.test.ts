import { describe, it, expect } from "vitest";
import { IctSessionLevelTracker, buildSessionReferenceLevelsMap } from "./session-levels.js";
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
  // IST is UTC + 5:30. So UTC = IST - 5:30
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

describe("IctSessionLevelTracker", () => {
  it("strictly prevents look-ahead: Day 1 sees null levels, Day 2 sees Day 1 resolved levels", () => {
    const tracker = new IctSessionLevelTracker();
    const day1Bars: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105),
      makeIstCandle("2026-01-05", 9, 20, 105, 120, 104, 115),
      makeIstCandle("2026-01-05", 15, 25, 115, 116, 100, 102),
    ];

    const candles = [...day1Bars];
    for (let i = 0; i < day1Bars.length; i++) {
      const snap = tracker.processCandle(candles, i);
      expect(snap.levels).toBeNull(); // Day 1 has no prior session in this stream
      expect(snap.currentSessionHigh).toBe(i === 0 ? 110 : 120);
      expect(snap.currentSessionLow).toBe(95);
      expect(snap.currentSessionDate).toBe("2026-01-05");
    }

    // Now Day 2 opens
    const day2Bar1 = makeIstCandle("2026-01-06", 9, 15, 103, 108, 101, 106);
    candles.push(day2Bar1);
    const snapDay2 = tracker.processCandle(candles, 3);

    expect(snapDay2.levels).not.toBeNull();
    expect(snapDay2.levels?.priorSessionDate).toBe("2026-01-05");
    expect(snapDay2.levels?.sessionDate).toBe("2026-01-06");
    expect(snapDay2.levels?.pdh).toBe(120);
    expect(snapDay2.levels?.pdl).toBe(95);
    expect(snapDay2.levels?.pdo).toBe(100);
    expect(snapDay2.levels?.pdc).toBe(102);
    expect(snapDay2.levels?.eq).toBe(107.5);
  });

  it("detects PDH wick-only SWEEP (BSL run) vs ACCEPTANCE", () => {
    const tracker = new IctSessionLevelTracker();
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105), // Day 1 PDH=110, PDL=95
    ];
    tracker.processCandle(candles, 0);

    // Day 2 Bar 1: Sweeps PDH (110) with High=112, but closes back inside at 108 -> SWEEP
    candles.push(makeIstCandle("2026-01-06", 9, 15, 105, 112, 104, 108));
    const snap1 = tracker.processCandle(candles, 1);
    expect(snap1.lastSweepEvent).not.toBeNull();
    expect(snap1.lastSweepEvent?.eventType).toBe("SWEEP");
    expect(snap1.lastSweepEvent?.levelType).toBe("PDH");
    expect(snap1.lastSweepEvent?.levelPrice).toBe(110);

    // Day 2 Bar 2: Pierces PDH and body closes above at 115 -> ACCEPTANCE
    candles.push(makeIstCandle("2026-01-06", 9, 20, 108, 116, 107, 115));
    const snap2 = tracker.processCandle(candles, 2);
    expect(snap2.lastSweepEvent).not.toBeNull();
    expect(snap2.lastSweepEvent?.eventType).toBe("ACCEPTANCE");
    expect(snap2.lastSweepEvent?.levelType).toBe("PDH");
  });

  it("detects PDL wick-only SWEEP (SSL run) vs ACCEPTANCE", () => {
    const tracker = new IctSessionLevelTracker();
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105), // Day 1 PDH=110, PDL=95
    ];
    tracker.processCandle(candles, 0);

    // Day 2 Bar 1: Sweeps PDL (95) with Low=93, but closes back inside at 97 -> SWEEP
    candles.push(makeIstCandle("2026-01-06", 9, 15, 100, 102, 93, 97));
    const snap1 = tracker.processCandle(candles, 1);
    expect(snap1.lastSweepEvent).not.toBeNull();
    expect(snap1.lastSweepEvent?.eventType).toBe("SWEEP");
    expect(snap1.lastSweepEvent?.levelType).toBe("PDL");
    expect(snap1.lastSweepEvent?.levelPrice).toBe(95);

    // Day 2 Bar 2: Breaks down and closes below PDL at 92 -> ACCEPTANCE
    candles.push(makeIstCandle("2026-01-06", 9, 20, 97, 98, 91, 92));
    const snap2 = tracker.processCandle(candles, 2);
    expect(snap2.lastSweepEvent).not.toBeNull();
    expect(snap2.lastSweepEvent?.eventType).toBe("ACCEPTANCE");
    expect(snap2.lastSweepEvent?.levelType).toBe("PDL");
  });

  it("buildSessionReferenceLevelsMap maps multi-day sessions correctly", () => {
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105),
      makeIstCandle("2026-01-05", 15, 25, 105, 108, 102, 107),
      makeIstCandle("2026-01-06", 9, 15, 107, 115, 106, 114),
      makeIstCandle("2026-01-06", 15, 25, 114, 116, 110, 112),
      makeIstCandle("2026-01-07", 9, 15, 112, 120, 111, 119),
    ];

    const map = buildSessionReferenceLevelsMap(candles);
    expect(map.size).toBe(2); // 2026-01-06 and 2026-01-07

    const day2 = map.get("2026-01-06")!;
    expect(day2.pdh).toBe(110);
    expect(day2.pdl).toBe(95);
    expect(day2.pdc).toBe(107);

    const day3 = map.get("2026-01-07")!;
    expect(day3.pdh).toBe(116);
    expect(day3.pdl).toBe(106);
    expect(day3.pdc).toBe(112);
  });
});
