import { describe, expect, it } from "vitest";
import type { ProtectiveStopPolicy } from "../../paper-trading/domain/protective-stop.js";
import { advanceUnderlyingProtectiveStop } from "./underlying-protective-stop.js";

/** LONG: entry 100, stop 90 -> 1R = 10. SHORT: entry 100, stop 110 -> 1R = 10. */
const longBase = { side: "LONG" as const, entryPrice: 100, initialStopLoss: 90, currentStopLoss: 90, tickSize: 0.05 };
const shortBase = { side: "SHORT" as const, entryPrice: 100, initialStopLoss: 110, currentStopLoss: 110, tickSize: 0.05 };
const breakEvenOnly: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: null };
const withTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 1, distanceR: 0.5 } };

describe("advanceUnderlyingProtectiveStop, LONG", () => {
  it("does not move below the break-even trigger", () => {
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 104, policy: breakEvenOnly })).toBeNull();
  });

  it("moves to one tick below entry at the break-even trigger", () => {
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 105, policy: breakEvenOnly })).toBe(99.95);
  });

  it("caps a trail that would cross entry at the same one-tick floor", () => {
    // +1R at 110, trailing 0.5R behind => 105, which is above entry -- capped at 99.95.
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 110, policy: withTrail })).toBe(99.95);
  });

  it("applies the trail unclamped once it naturally sits below entry", () => {
    const wideTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 0.6, distanceR: 0.8 } };
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 106, policy: wideTrail })).toBe(98);
  });

  it("never widens the stop already in force", () => {
    expect(advanceUnderlyingProtectiveStop({
      ...longBase, currentStopLoss: 99.95, peakFavorable: 105, policy: breakEvenOnly,
    })).toBeNull();
  });
});

describe("advanceUnderlyingProtectiveStop, SHORT", () => {
  it("does not move above the break-even trigger", () => {
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 96, policy: breakEvenOnly })).toBeNull();
  });

  it("moves to one tick above entry at the break-even trigger", () => {
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 95, policy: breakEvenOnly })).toBe(100.05);
  });

  it("caps a trail that would cross entry at the same one-tick ceiling", () => {
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 90, policy: withTrail })).toBe(100.05);
  });

  it("applies the trail unclamped once it naturally sits above entry", () => {
    const wideTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 0.6, distanceR: 0.8 } };
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 94, policy: wideTrail })).toBe(102);
  });

  it("never widens the stop already in force", () => {
    expect(advanceUnderlyingProtectiveStop({
      ...shortBase, currentStopLoss: 100.05, peakFavorable: 95, policy: breakEvenOnly,
    })).toBeNull();
  });
});

/*
 * The backtester carried the same entry-price clamp as the live path, so every trailing arm this
 * project has measured -- including the NO_EDGE verdict recorded against trailing -- was a result
 * about break-even. See migration 117 for the replay that established that.
 */
describe("profit-locking trail", () => {
  const lockTrail: ProtectiveStopPolicy = {
    breakEvenTriggerR: 0.5,
    trail: { triggerR: 1, distanceR: 0.5, lockProfit: true },
  };

  it("LONG: trails above entry instead of capping at one tick below it", () => {
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 110, policy: lockTrail })).toBe(105);
    // Identical geometry, flag omitted -- the capped value the same inputs produce today.
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 110, policy: withTrail })).toBe(99.95);
  });

  it("SHORT: trails below entry, the mirror of the same lock", () => {
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 90, policy: lockTrail })).toBe(95);
    expect(advanceUnderlyingProtectiveStop({ ...shortBase, peakFavorable: 90, policy: withTrail })).toBe(100.05);
  });

  it("clamps break-even even under a lock policy, since break-even IS entry by definition", () => {
    // +0.6R: past the break-even trigger, short of the trail's 1R. The break-even branch still floors.
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: 106, policy: lockTrail })).toBe(99.95);
  });

  it("stays monotonic once above entry", () => {
    expect(advanceUnderlyingProtectiveStop({
      ...longBase, currentStopLoss: 106, peakFavorable: 110, policy: lockTrail,
    })).toBeNull();
  });
});

describe("refusals", () => {
  it("refuses a non-positive risk", () => {
    expect(advanceUnderlyingProtectiveStop({
      ...longBase, initialStopLoss: 100, peakFavorable: 120, policy: withTrail,
    })).toBeNull();
  });

  it("refuses a non-finite peak", () => {
    expect(advanceUnderlyingProtectiveStop({ ...longBase, peakFavorable: Number.NaN, policy: withTrail })).toBeNull();
  });
});
