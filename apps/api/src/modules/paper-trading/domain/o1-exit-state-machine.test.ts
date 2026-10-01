import { describe, expect, it } from "vitest";
import { evaluateO1TradeExit } from "./o1-exit-state-machine.js";

const OPENED_AT = new Date("2026-10-01T10:00:00.000Z");

describe("evaluateO1TradeExit (O1 Exit State Machine)", () => {
  it("triggers HARD_STOP when option price reaches effectivePremiumStop", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 752,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"),
      currentOptionPrice: 500, // <= stop (520)
      effectivePremiumStop: 520,
      effectivePremiumTarget: 1200,
      currentUnderlyingPrice: 57600,
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("HARD_STOP");
  });

  it("triggers UNDERLYING_INVALIDATION for LONG when underlying reaches invalidationLevelAtEntry", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 752,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"),
      currentOptionPrice: 600, // option price above stop
      effectivePremiumStop: 520,
      effectivePremiumTarget: 1200,
      currentUnderlyingPrice: 57290, // <= 57300 invalidation
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("UNDERLYING_INVALIDATION");
  });

  it("triggers UNDERLYING_INVALIDATION for SHORT when underlying reaches invalidationLevelAtEntry", () => {
    const res = evaluateO1TradeExit({
      side: "LONG", // option side is always LONG for option buyers
      underlyingDirection: "SHORT",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 58000,
      initialRiskDistance: 280,
      entryOptionPrice: 500,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"),
      currentOptionPrice: 400,
      effectivePremiumStop: 300,
      effectivePremiumTarget: 800,
      currentUnderlyingPrice: 58010, // >= 58000 invalidation for SHORT
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("UNDERLYING_INVALIDATION");
  });

  it("skips UNDERLYING_INVALIDATION, TIME_STOP, and PREMIUM_TOLERANCE when underlying price is null (outage rule)", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 752,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:20:00.000Z"), // holding 20 minutes > 15m
      currentOptionPrice: 700, // option price healthy
      effectivePremiumStop: 520,
      effectivePremiumTarget: 1200,
      currentUnderlyingPrice: null, // Outage: underlying unavailable!
    });

    expect(res.shouldExit).toBe(false);
    expect(res.exitReason).toBeNull();
    expect(res.telemetry.progressR).toBeNull();
    expect(res.telemetry.underlyingMoveBps).toBeNull();
  });

  it("triggers TIME_STOP when holdingMinutes > 15 and progressR < 0.30", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300, // initialRiskDistance = 420
      initialRiskDistance: 420,
      entryOptionPrice: 752,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:16:00.000Z"), // 16 minutes holding
      currentOptionPrice: 740,
      effectivePremiumStop: 520,
      effectivePremiumTarget: 1200,
      currentUnderlyingPrice: 57760, // favorable move = 40. progressR = 40/420 = 0.095 < 0.30
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("TIME_STOP");
    expect(res.telemetry.progressR).toBeCloseTo(40 / 420, 3);
  });

  it("triggers PREMIUM_TOLERANCE when underlyingMoveBps >= 15 but option premium drawdown >= 25%", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 1000,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"), // holding 5 min
      currentOptionPrice: 700, // 300 drawdown on 1000 = 30% >= 25%
      effectivePremiumStop: 500,
      effectivePremiumTarget: 1800,
      currentUnderlyingPrice: 57850, // +130 points move = +22.5 bps >= 15 bps
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("PREMIUM_TOLERANCE");
  });

  it("triggers TARGET_REACHED when currentOptionPrice reaches effectivePremiumTarget", () => {
    const res = evaluateO1TradeExit({
      side: "LONG",
      underlyingDirection: "LONG",
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 752,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:10:00.000Z"),
      currentOptionPrice: 1250, // >= target 1200
      effectivePremiumStop: 520,
      effectivePremiumTarget: 1200,
      currentUnderlyingPrice: 58200,
    });

    expect(res.shouldExit).toBe(true);
    expect(res.exitReason).toBe("TARGET_REACHED");
  });
});
