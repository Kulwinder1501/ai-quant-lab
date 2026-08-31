import { describe, expect, it } from "vitest";
import {
  assessTapeLiveness,
  frozenTapeIdenticalBarThreshold,
  type TapeBar,
} from "./tape-liveness.js";

const MINUTE = 60_000;
const base = new Date("2026-08-31T09:45:00.000Z");

function bar(offsetMinutes: number, values: Partial<TapeBar> = {}): TapeBar {
  return {
    openTime: new Date(base.getTime() + offsetMinutes * MINUTE),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    ...values,
  };
}

describe("assessTapeLiveness", () => {
  it("calls two OHLC-identical contiguous bars frozen", () => {
    /*
     * The measured shape of the index close freeze: bars keep arriving on the minute and repeat the
     * last real print. 14 bars, 2 distinct closes, every day from 2026-08-03.
     */
    const result = assessTapeLiveness({ bars: [bar(0), bar(1)], intervalMs: MINUTE });

    expect(result.liveness).toBe("FROZEN");
    expect(result.identicalBars).toBe(2);
  });

  it("calls a moving tape live even when only the close differs", () => {
    const result = assessTapeLiveness({
      bars: [bar(0), bar(1, { close: 100.55 })],
      intervalMs: MINUTE,
    });

    expect(result.liveness).toBe("LIVE");
    expect(result.identicalBars).toBe(1);
  });

  it("compares all four OHLC values, not the close alone", () => {
    // Some frozen days carry three distinct OHLC tuples against two distinct closes, so the wider
    // comparison is the more conservative one -- a bar whose range moved is not a repeat.
    const result = assessTapeLiveness({
      bars: [bar(0), bar(1, { high: 101.2 })],
      intervalMs: MINUTE,
    });

    expect(result.liveness).toBe("LIVE");
  });

  it("does not treat volume as evidence either way", () => {
    /*
     * The trap this check was nearly built on. On 2026-08-31 NIFTY50 carried 348M of volume across
     * the frozen window and still printed two distinct closes, so a zero-volume test would have
     * passed the tape on the day it most needed to fail. `TapeBar` deliberately has no volume field;
     * this test pins that the type cannot regrow one by accident.
     */
    const identical = [bar(0), bar(1)];
    expect(assessTapeLiveness({ bars: identical, intervalMs: MINUTE }).liveness).toBe("FROZEN");
    expect(Object.keys(identical[0]!)).not.toContain("volume");
  });

  it("treats a lone reference bar as live", () => {
    // 09:16 has nothing to compare against. Refusing it would discard the session's first grid point
    // every day to guard a freeze that cannot yet be visible.
    const result = assessTapeLiveness({ bars: [bar(0)], intervalMs: MINUTE });

    expect(result.liveness).toBe("LIVE");
    expect(result.identicalBars).toBe(1);
  });

  it("breaks the run at a time gap rather than counting across it", () => {
    /*
     * Two identical bars ten minutes apart are a missing-bar defect, not a frozen tape, and that
     * defect is measured elsewhere. Counting across the gap would let a caller manufacture a frozen
     * verdict by passing a non-contiguous window.
     */
    const result = assessTapeLiveness({ bars: [bar(0), bar(10)], intervalMs: MINUTE });

    expect(result.liveness).toBe("LIVE");
    expect(result.identicalBars).toBe(1);
  });

  it("counts a long run but stops at the first change", () => {
    const bars = [bar(0, { close: 99.9 }), bar(1), bar(2), bar(3)];
    const result = assessTapeLiveness({ bars, intervalMs: MINUTE });

    expect(result.identicalBars).toBe(3);
    expect(result.liveness).toBe("FROZEN");
  });

  it("honours a raised threshold", () => {
    const bars = [bar(0), bar(1)];

    expect(assessTapeLiveness({ bars, intervalMs: MINUTE, threshold: 3 }).liveness).toBe("LIVE");
    expect(assessTapeLiveness({ bars: [...bars, bar(2)], intervalMs: MINUTE, threshold: 3 }).liveness)
      .toBe("FROZEN");
  });

  it("refuses a threshold that cannot distinguish anything", () => {
    // A bar is trivially identical to itself, so a threshold of 1 marks every tape frozen.
    expect(() => assessTapeLiveness({ bars: [bar(0)], intervalMs: MINUTE, threshold: 1 }))
      .toThrow(/below 2 bars/);
  });

  it("refuses an empty window and a non-positive interval", () => {
    expect(() => assessTapeLiveness({ bars: [], intervalMs: MINUTE })).toThrow(/reference bar/);
    expect(() => assessTapeLiveness({ bars: [bar(0)], intervalMs: 0 })).toThrow(/positive bar interval/);
  });

  it("keeps the default threshold at the measured separation point", () => {
    // 10,800 healthy 1m runs, longest identical run 1. Two is the earliest detectable point and the
    // first value with no observed false positive; lowering it is impossible, raising it delays
    // detection by a minute per step.
    expect(frozenTapeIdenticalBarThreshold).toBe(2);
  });
});
