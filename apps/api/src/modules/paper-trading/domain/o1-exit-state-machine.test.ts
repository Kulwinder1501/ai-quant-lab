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

  /**
   * PREMIUM_TOLERANCE is the "flat underlying, bleeding premium" check: the underlying has
   * NOT moved meaningfully (< 10 bps) while the option has decayed hard (pure theta/vega
   * drag, not a directional stop) -- and it should only fire once the position has been held
   * long enough (> 10 min) to rule out opening-print noise. The frozen spec is:
   *
   *   underlyingMoveBps < 10 AND holdingMinutes > 10 AND premiumLossPct > 0.25 -> EXIT
   *
   * A shared base keeps HARD_STOP / UNDERLYING_INVALIDATION / TIME_STOP / TARGET_REACHED out
   * of range (option price between stop and target, underlying nowhere near the invalidation
   * level, holding <= 15 min so TIME_STOP's own >15min gate never engages) so each case below
   * isolates the PREMIUM_TOLERANCE condition itself.
   */
  describe("PREMIUM_TOLERANCE (flat underlying, bleeding premium)", () => {
    const base = {
      side: "LONG" as const,
      underlyingDirection: "LONG" as const,
      entryUnderlying: 57720,
      invalidationLevelAtEntry: 57300,
      initialRiskDistance: 420,
      entryOptionPrice: 1000,
      openedAt: OPENED_AT,
      effectivePremiumStop: 500,
      effectivePremiumTarget: 1800,
    };

    it("does NOT trigger when held < 10 minutes, even with bps < 10 and loss > 25%", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:05:00.000Z"), // holding 5 min <= 10
        currentOptionPrice: 700, // 30% drawdown > 25%
        currentUnderlyingPrice: 57740, // +20 pts = +3.47 bps < 10
      });

      expect(res.shouldExit).toBe(false);
      expect(res.exitReason).toBeNull();
    });

    it("does NOT trigger when the underlying HAS moved meaningfully (bps >= 10), even held > 10 min and loss > 25%", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:11:00.000Z"), // holding 11 min > 10
        currentOptionPrice: 700, // 30% drawdown > 25%
        currentUnderlyingPrice: 57807, // +87 pts = +15.07 bps, a real move -> not "flat"
      });

      expect(res.shouldExit).toBe(false);
      expect(res.exitReason).toBeNull();
    });

    it("triggers when held > 10 min, underlying flat (bps < 10), and premium loss > 25%", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:11:00.000Z"), // holding 11 min > 10
        currentOptionPrice: 700, // 30% drawdown > 25%
        currentUnderlyingPrice: 57740, // +20 pts = +3.47 bps < 10
      });

      expect(res.shouldExit).toBe(true);
      expect(res.exitReason).toBe("PREMIUM_TOLERANCE");
    });

    it("boundary: exactly 10 minutes held does NOT trigger (gate is strictly > 10)", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:10:00.000Z"), // holding exactly 10 min
        currentOptionPrice: 700, // 30% drawdown > 25%
        currentUnderlyingPrice: 57740, // +3.47 bps < 10
      });

      expect(res.telemetry.holdingMinutes).toBe(10);
      expect(res.shouldExit).toBe(false);
      expect(res.exitReason).toBeNull();
    });

    it("boundary: exactly 10 bps move does NOT trigger (gate is strictly < 10)", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:11:00.000Z"), // holding 11 min > 10
        currentOptionPrice: 700, // 30% drawdown > 25%
        currentUnderlyingPrice: 57777.72, // +57.72 pts = exactly 10 bps on entry 57720
      });

      expect(res.telemetry.underlyingMoveBps).toBeCloseTo(10, 6);
      expect(res.shouldExit).toBe(false);
      expect(res.exitReason).toBeNull();
    });

    it("boundary: exactly 25% premium loss does NOT trigger (gate is strictly > 0.25)", () => {
      const res = evaluateO1TradeExit({
        ...base,
        now: new Date("2026-10-01T10:11:00.000Z"), // holding 11 min > 10
        currentOptionPrice: 750, // exactly 25% drawdown on entry 1000
        currentUnderlyingPrice: 57740, // +3.47 bps < 10
      });

      expect(res.telemetry.premiumDrawdownPct).toBeCloseTo(0.25, 6);
      expect(res.shouldExit).toBe(false);
      expect(res.exitReason).toBeNull();
    });
  });

  /**
   * The exact scenario the audit reproduced against the live bug: `postgres-paper-trade-
   * repository.ts` persisted `underlying_direction` from the trade's own `side` (always
   * `"LONG"` for an option buyer) instead of the idea's real thesis direction, so a PE
   * (bearish) position's `underlyingDirection` was wrongly stored as `"LONG"`.
   *
   * This function is pure and correct for whatever `underlyingDirection` it is handed -- that
   * is exactly why these tests, with the value supplied correctly, cannot by themselves prove
   * the production bug is fixed. What follows reproduces both the broken behaviour (wrong
   * input, matching what the repository used to persist) and the fixed behaviour (correct
   * input, matching what it persists now) for the same PE position and the same underlying
   * path, so the contrast is explicit. The data-flow fix is proven separately, in
   * `prepare-option-entry.test.ts` and `postgres-paper-trade-repository.test.ts`, which show
   * the correct value actually reaches this field.
   */
  describe("PE (bearish-thesis) position -- the audit's reproduction", () => {
    const peBase = {
      side: "LONG" as const, // an option buyer's own side is always LONG, PE included
      entryUnderlying: 57_720,
      invalidationLevelAtEntry: 58_140, // the real structural stop: above entry, for a PE
      initialRiskDistance: 420,
      entryOptionPrice: 500,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"),
      currentOptionPrice: 600, // comfortably above the premium stop either way
      effectivePremiumStop: 300,
      effectivePremiumTarget: 900,
    };

    it("a favourable fall must NOT exit, but does under the bug's wrong (LONG) direction", () => {
      const underlyingFellFavourably = { ...peBase, currentUnderlyingPrice: 57_300 }; // fell 420

      const correct = evaluateO1TradeExit({ ...underlyingFellFavourably, underlyingDirection: "SHORT" });
      expect(correct.shouldExit).toBe(false);
      expect(correct.exitReason).toBeNull();

      // Reproduces the bug: persisting `side` ("LONG") instead of the real PE thesis made a
      // favourable move look like the underlying crossing a LONG invalidation level.
      const buggy = evaluateO1TradeExit({ ...underlyingFellFavourably, underlyingDirection: "LONG" });
      expect(buggy.shouldExit).toBe(true);
      expect(buggy.exitReason).toBe("UNDERLYING_INVALIDATION");
    });

    it("a genuine invalidating rise MUST exit, but is missed under the bug's wrong (LONG) direction", () => {
      const underlyingRoseThroughStop = { ...peBase, currentUnderlyingPrice: 58_200 }; // >= 58,140

      const correct = evaluateO1TradeExit({ ...underlyingRoseThroughStop, underlyingDirection: "SHORT" });
      expect(correct.shouldExit).toBe(true);
      expect(correct.exitReason).toBe("UNDERLYING_INVALIDATION");

      // Reproduces the bug: a genuine break of the structural stop went uncaught because the
      // (wrongly LONG) direction checks for the underlying falling, not rising.
      const buggy = evaluateO1TradeExit({ ...underlyingRoseThroughStop, underlyingDirection: "LONG" });
      expect(buggy.shouldExit).toBe(false);
      expect(buggy.exitReason).toBeNull();
    });
  });

  /** Symmetric check: the fix must not regress the CE (bullish) side it already worked on. */
  describe("CE (bullish-thesis) position -- symmetric regression guard", () => {
    const ceBase = {
      side: "LONG" as const,
      entryUnderlying: 57_720,
      invalidationLevelAtEntry: 57_300, // below entry, for a CE
      initialRiskDistance: 420,
      entryOptionPrice: 500,
      openedAt: OPENED_AT,
      now: new Date("2026-10-01T10:05:00.000Z"),
      currentOptionPrice: 600,
      effectivePremiumStop: 300,
      effectivePremiumTarget: 900,
    };

    it("a favourable rise does not exit under the correct LONG direction", () => {
      const underlyingRoseFavourably = { ...ceBase, currentUnderlyingPrice: 58_140 }; // rose 420
      const result = evaluateO1TradeExit({ ...underlyingRoseFavourably, underlyingDirection: "LONG" });

      expect(result.shouldExit).toBe(false);
      expect(result.exitReason).toBeNull();
    });

    it("a genuine invalidating fall exits under the correct LONG direction", () => {
      const underlyingFellThroughStop = { ...ceBase, currentUnderlyingPrice: 57_200 }; // <= 57,300
      const result = evaluateO1TradeExit({ ...underlyingFellThroughStop, underlyingDirection: "LONG" });

      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe("UNDERLYING_INVALIDATION");
    });
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
