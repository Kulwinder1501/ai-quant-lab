import { describe, expect, it } from "vitest";
import { istInstant } from "../../platform/calendar/trading-session.js";
import { measureSession, MIN_CLOSE_WINDOW_BARS } from "./session-outcome.js";
import type { MinuteBar } from "./targets.js";

const DATE = "2026-10-12";
const at = (h: number, m: number): Date => istInstant(DATE, h * 60 + m);
const bar = (h: number, m: number, o: number, hi: number, lo: number, c: number, volume: number | null = 100): MinuteBar => ({ openTime: at(h, m), open: o, high: hi, low: lo, close: c, volume });

/** 30 closing bars (15:00-15:29) at a flat price, each with volume. */
const closeWindow = (price: number, count = 30): MinuteBar[] => Array.from({ length: count }, (_, i) => bar(15, i, price, price, price, price));

const base = { instrument: "NIFTY50" as const, sessionDate: DATE, candidateLevels: [] };

describe("measureSession", () => {
  it("measures all three targets from the defined bars", () => {
    const bars = [
      bar(9, 15, 22600, 22610, 22590, 22605),     // open 22600
      bar(10, 14, 22640, 22650, 22630, 22646),    // close at 10:15 = 22646
      ...closeWindow(22680),                       // VWAP 22680
    ];
    const outcome = measureSession({ ...base, previousClose: 22520.45, bars });
    expect(outcome.open0915).toBe(22600);
    expect(outcome.gapReturnPct).toBeCloseTo(((22600 - 22520.45) / 22520.45) * 100, 8);
    expect(outcome.gapOutcome).toBe("UP");               // +0.353% vs 0.25 threshold
    expect(outcome.price1015).toBe(22646);
    expect(outcome.first60Outcome).toBe("UP");           // +0.2035% vs 0.20
    expect(outcome.closingVwap).toBeCloseTo(22680, 8);
    expect(outcome.fullSessionOutcome).toBe("UP");       // +0.354% vs 0.30
    expect(outcome.unmeasurable).toEqual({});
  });

  it("classifies a move inside the band as FLAT", () => {
    const bars = [bar(9, 15, 22600, 22600, 22600, 22600), bar(10, 14, 22610, 22610, 22610, 22610), ...closeWindow(22620)];
    const outcome = measureSession({ ...base, previousClose: 22590, bars });
    expect(outcome.gapOutcome).toBe("FLAT");
    expect(outcome.first60Outcome).toBe("FLAT");
    expect(outcome.fullSessionOutcome).toBe("FLAT");
  });

  it("records the reason a target cannot be measured and never substitutes a neighbouring bar", () => {
    // No 09:15 bar, only 09:16: nothing may be inferred from it.
    const noOpen = measureSession({ ...base, previousClose: 22520, bars: [bar(9, 16, 22600, 22600, 22600, 22600), ...closeWindow(22680)] });
    expect(noOpen.unmeasurable).toEqual({ OPENING_GAP: "NO_0915_BAR", FIRST_60_MINUTES: "NO_0915_BAR", FULL_SESSION: "NO_0915_BAR" });
    expect(noOpen.gapOutcome).toBeNull();

    const noMark = measureSession({ ...base, previousClose: 22520, bars: [bar(9, 15, 22600, 22600, 22600, 22600), bar(10, 15, 22700, 22700, 22700, 22700), ...closeWindow(22680)] });
    expect(noMark.unmeasurable.FIRST_60_MINUTES).toBe("NO_1014_BAR");
    expect(noMark.gapOutcome).toBe("UP");

    const noPrev = measureSession({ ...base, previousClose: null, bars: [bar(9, 15, 22600, 22600, 22600, 22600)] });
    expect(noPrev.unmeasurable.OPENING_GAP).toBe("NO_PREVIOUS_CLOSE");
  });

  it("refuses a closing VWAP built from a thin window, which is what a frozen feed looks like", () => {
    const bars = [bar(9, 15, 22600, 22600, 22600, 22600), ...closeWindow(22680, MIN_CLOSE_WINDOW_BARS - 1)];
    const outcome = measureSession({ ...base, previousClose: 22520, bars });
    expect(outcome.closingVwap).toBeNull();
    expect(outcome.unmeasurable.FULL_SESSION).toBe(`CLOSE_WINDOW_HAS_${MIN_CLOSE_WINDOW_BARS - 1}_BARS`);
  });

  it("refuses a full window with no volume rather than falling back to a plain average", () => {
    const bars = [bar(9, 15, 22600, 22600, 22600, 22600), ...Array.from({ length: 30 }, (_, i) => bar(15, i, 22680, 22680, 22680, 22680, null))];
    const outcome = measureSession({ ...base, previousClose: 22520, bars });
    expect(outcome.unmeasurable.FULL_SESSION).toBe("NO_CLOSE_WINDOW_VOLUME");
  });

  it("records which candidate levels the session touched, and when first", () => {
    const outcome = measureSession({
      ...base,
      previousClose: 22520,
      bars: [bar(9, 15, 22600, 22610, 22590, 22605), bar(11, 0, 22700, 22720, 22690, 22710)],
      candidateLevels: [
        { id: "level-nifty50-a", instrument: "NIFTY50", label: "a", price: 22715 },
        { id: "level-nifty50-b", instrument: "NIFTY50", label: "b", price: 23000 },
        { id: "level-banknifty-c", instrument: "BANKNIFTY", label: "c", price: 22600 },
      ],
    });
    expect(outcome.levelTouches).toEqual([
      { levelRef: "level-nifty50-a", price: 22715, touched: true, firstTouchAt: at(11, 0).toISOString() },
      { levelRef: "level-nifty50-b", price: 23000, touched: false, firstTouchAt: null },
    ]);
  });
});
