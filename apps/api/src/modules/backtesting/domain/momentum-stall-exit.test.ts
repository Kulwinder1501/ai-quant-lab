import { describe, expect, it } from "vitest";
import { isMomentumStalled, type MomentumStallCheckInput } from "./momentum-stall-exit.js";

const policy = { cutoffMinutes: 10, minimumProgressR: 0.5 };

/** LONG scalp: entry 100, stop 90 (1R = 10), target 112 (1.2R, <= 1.6 => scalp). */
const longScalp: MomentumStallCheckInput = {
  side: "LONG",
  entryPrice: 100,
  initialStopLoss: 90,
  targetPrice: 112,
  openedAt: new Date("2026-01-01T09:15:00Z"),
  asOf: new Date("2026-01-01T09:25:00Z"), // +10 minutes
  currentPrice: 100,
  policy,
};

/** SHORT scalp: entry 100, stop 110 (1R = 10), target 88 (1.2R). */
const shortScalp: MomentumStallCheckInput = {
  side: "SHORT",
  entryPrice: 100,
  initialStopLoss: 110,
  targetPrice: 88,
  openedAt: new Date("2026-01-01T09:15:00Z"),
  asOf: new Date("2026-01-01T09:25:00Z"),
  currentPrice: 100,
  policy,
};

describe("isMomentumStalled, LONG", () => {
  it("is stalled: scalp, cutoff elapsed, no progress", () => {
    expect(isMomentumStalled(longScalp)).toBe(true);
  });

  it("is not stalled once minimumProgressR is reached", () => {
    // +0.5R = 105
    expect(isMomentumStalled({ ...longScalp, currentPrice: 105 })).toBe(false);
  });

  it("is not stalled before the cutoff elapses", () => {
    expect(isMomentumStalled({ ...longScalp, asOf: new Date("2026-01-01T09:24:00Z") })).toBe(false);
  });
});

describe("isMomentumStalled, SHORT (mirror)", () => {
  it("is stalled: scalp, cutoff elapsed, no progress", () => {
    expect(isMomentumStalled(shortScalp)).toBe(true);
  });

  it("is not stalled once minimumProgressR is reached", () => {
    // +0.5R for a SHORT is entry - 0.5*risk = 95
    expect(isMomentumStalled({ ...shortScalp, currentPrice: 95 })).toBe(false);
  });

  it("is not stalled before the cutoff elapses", () => {
    expect(isMomentumStalled({ ...shortScalp, asOf: new Date("2026-01-01T09:24:00Z") })).toBe(false);
  });
});

describe("isMomentumStalled, refusals", () => {
  it("is not stalled when Reward/Risk > 1.6 (a directional setup, not a scalp)", () => {
    // target 117 => reward 17, risk 10 => R/R 1.7, above the 1.6 scalp threshold.
    expect(isMomentumStalled({ ...longScalp, targetPrice: 117 })).toBe(false);
  });

  it("is not stalled when initialRisk <= 0 (degenerate geometry)", () => {
    expect(isMomentumStalled({ ...longScalp, initialStopLoss: 100 })).toBe(false);
    expect(isMomentumStalled({ ...longScalp, initialStopLoss: 105 })).toBe(false);
  });
});
