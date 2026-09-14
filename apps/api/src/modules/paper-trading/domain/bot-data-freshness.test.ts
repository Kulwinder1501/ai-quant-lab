import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BAR_AGE_MINUTES,
  assessDataFreshness,
} from "./bot-data-freshness.js";

const NOW = new Date("2026-08-06T09:00:00.000Z");

describe("assessDataFreshness", () => {
  it("accepts a bar from within the window", () => {
    const result = assessDataFreshness({
      symbol: "NIFTY50", now: NOW,
      latestBarCloseTime: new Date(NOW.getTime() - 5 * 60_000),
    });

    expect(result.fresh).toBe(true);
    if (result.fresh) expect(result.ageMinutes).toBeCloseTo(5, 6);
  });

  // The case this exists for. On 2026-08-06 the bot's BANKNIFTY 1m data ended 31 July and
  // it would have filled a signal at that price without a word.
  it("refuses a six-day-old bar and says collection has stopped", () => {
    const result = assessDataFreshness({
      symbol: "BANKNIFTY", now: NOW,
      latestBarCloseTime: new Date("2026-07-31T10:00:00.000Z"),
    });

    expect(result.fresh).toBe(false);
    if (!result.fresh) {
      expect(result.reason).toBe("STALE");
      expect(result.explanation).toMatch(/Collection has probably stopped/);
      expect(result.ageMinutes).toBeGreaterThan(8_000);
    }
  });

  it("refuses when there is no bar at all", () => {
    const result = assessDataFreshness({ symbol: "SBIN", now: NOW, latestBarCloseTime: null });

    expect(result.fresh).toBe(false);
    if (!result.fresh) expect(result.reason).toBe("NO_DATA");
  });

  it("treats a future-dated bar as a clock fault, not as very fresh", () => {
    // A negative age would otherwise sail through the upper bound.
    const result = assessDataFreshness({
      symbol: "NIFTY50", now: NOW,
      latestBarCloseTime: new Date(NOW.getTime() + 60 * 60_000),
    });

    expect(result.fresh).toBe(false);
    if (!result.fresh) expect(result.explanation).toMatch(/clock fault/);
  });

  it("honours a caller-supplied limit", () => {
    const bar = new Date(NOW.getTime() - 30 * 60_000);

    expect(assessDataFreshness({ symbol: "X", now: NOW, latestBarCloseTime: bar }).fresh).toBe(false);
    expect(assessDataFreshness({ symbol: "X", now: NOW, latestBarCloseTime: bar, maxAgeMinutes: 60 }).fresh).toBe(true);
  });

  it("defaults to a limit tighter than one session", () => {
    expect(DEFAULT_MAX_BAR_AGE_MINUTES).toBeLessThan(375);
  });
});
