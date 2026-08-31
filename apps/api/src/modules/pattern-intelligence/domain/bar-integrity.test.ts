import { describe, expect, it } from "vitest";
import { isStaleBar } from "./bar-integrity.js";
import type { CandleLike } from "./pattern-context-calculator.js";

const MINUTE = 60_000;
/** 15:15 IST on 2026-08-31 — the measured freeze onset. */
const freezeOnset = new Date("2026-08-31T09:45:00.000Z");

function bar(minute: number, values: Omit<CandleLike, "openTime">): CandleLike {
  return { openTime: new Date(freezeOnset.getTime() + minute * MINUTE), ...values };
}

/** The pinned print of the 2026-08-31 NIFTY50 freeze, at whatever volume the feed stamped on it. */
function pinned(minute: number, volume: number): CandleLike {
  return bar(minute, { open: 24050.25, high: 24050.25, low: 24050.25, close: 24050.25, volume });
}

describe("isStaleBar", () => {
  describe("the frozen index tape, which now carries volume", () => {
    it("refuses a repeated print however much volume the feed stamps on it", () => {
      // The measured 2026-08-31 NIFTY50 1m sequence. The old conjunction refused only the first four
      // of these and admitted the remaining nine, which were then observed.
      const volumes = [0, 0, 0, 0, 125_958_451, 2_800_000, 3_100_000, 4_000_000, 5_300_000];
      for (const [step, volume] of volumes.entries()) {
        const previous = pinned(step + 1, step === 0 ? 0 : volumes[step - 1]!);
        const candle = pinned(step + 2, volume);
        expect(isStaleBar(candle, { previous, intervalMs: MINUTE }), `volume ${volume}`).toBe(true);
      }
    });

    it("refuses the 126M-volume bar that the zero-volume conjunction admitted", () => {
      // The single row this fix exists for: 15:20, zero range, 125,958,451 of constituent volume.
      const candle = pinned(5, 125_958_451);
      expect(isStaleBar(candle)).toBe(false);                                      // old behaviour
      expect(isStaleBar(candle, { previous: pinned(4, 0), intervalMs: MINUTE })).toBe(true);
    });
  });

  describe("what the volume fallback still guards", () => {
    it("admits a moving bar whose volume dropped out", () => {
      // 2026-07-23 / 2026-03-10: volume 0 while price keeps moving. Price is trustworthy; only volume
      // is unknown, and `volume-semantics.ts` already nulls the volume statistics.
      const previous = bar(0, { open: 56539.75, high: 56545.0, low: 56530.0, close: 56527.10, volume: 0 });
      const candle = bar(1, { open: 56527.10, high: 56540.0, low: 56525.0, close: 56531.40, volume: 0 });
      expect(isStaleBar(candle, { previous, intervalMs: MINUTE })).toBe(false);
    });

    it("admits a single isolated flat bar on real volume", () => {
      // A dull but genuine print: zero range, real volume, and NOT a repeat of the bar before it.
      // 254 of the 279 recorded zero-range observations are this shape.
      const previous = bar(0, { open: 24040, high: 24055, low: 24035, close: 24050.25, volume: 9_100 });
      const candle = pinned(1, 8_893);
      expect(isStaleBar(candle, { previous, intervalMs: MINUTE })).toBe(false);
    });

    it("still refuses an isolated flat bar that reports no volume either", () => {
      // The original 2026-08-25 signature. It must not regress: nothing about this bar is an
      // observation, and there is no predecessor evidence to lean on.
      const previous = bar(0, { open: 24040, high: 24055, low: 24035, close: 24050.25, volume: 9_100 });
      const candle = pinned(1, 0);
      expect(isStaleBar(candle, { previous, intervalMs: MINUTE })).toBe(true);
      expect(isStaleBar(candle)).toBe(true);
    });
  });

  describe("contiguity", () => {
    it("does not call an identical bar across a gap frozen", () => {
      // Two OHLC-identical bars ten minutes apart are evidence of a missing bar, not a frozen tape —
      // a different defect with its own detector. Without contiguity this would fire on every
      // overnight close where the open repeats the prior close.
      const candle = pinned(10, 5_000);
      expect(isStaleBar(candle, { previous: pinned(0, 5_000), intervalMs: MINUTE })).toBe(false);
    });

    it("reads the interval the caller declares, not a hard-coded minute", () => {
      // The 5m series freezes on the same sessions; a 1m assumption would silently miss it. The
      // measured 5m case is NIFTY50 15:20 on 2026-08-31, volumeZscore 4.23 on a zero-range bar.
      const previous = pinned(0, 0);
      const candle = pinned(5, 142_663_286);
      expect(isStaleBar(candle, { previous, intervalMs: 5 * MINUTE })).toBe(true);
      expect(isStaleBar(candle, { previous, intervalMs: MINUTE })).toBe(false);
    });
  });

  describe("the no-predecessor fallback", () => {
    it("degrades to the single-bar test rather than passing the bar", () => {
      // First bar of a window: there is nothing to compare against. The weaker test still catches the
      // zero-volume form of the freeze; it cannot catch the volume-carrying form, which is why every
      // caller that has a predecessor must supply it.
      expect(isStaleBar(pinned(0, 0), { previous: null, intervalMs: MINUTE })).toBe(true);
      expect(isStaleBar(pinned(0, 5_000), { previous: null, intervalMs: MINUTE })).toBe(false);
    });
  });
});
