import { describe, expect, it } from "vitest";
import { followThrough, goldFollowThroughResolverVersion, reanchorBracket, settledLevels } from "./gold-follow-through.js";
import type { CompletedPriceCandle } from "./paper-trade-exit-policy.js";

const T0 = new Date("2026-10-12T05:00:00.000Z"); // first minute after the signal bar closed
const MINUTE = 60_000;

/** One 1m bar opening `index` minutes after T0. Defaults sit calmly mid-bracket. */
function bar(index: number, overrides: Partial<CompletedPriceCandle> = {}): CompletedPriceCandle {
  const openTime = new Date(T0.getTime() + index * MINUTE);
  return {
    id: `bar-${index}`,
    openTime,
    closeTime: new Date(openTime.getTime() + MINUTE),
    open: 4180, high: 4181, low: 4179, close: 4180,
    ...overrides,
  };
}

// SHORT from 4180: stop 4183 (risk 3), target 4175.5 (1.5R).
const SHORT = { side: "SHORT" as const, entryPrice: 4180, stopLoss: 4183, targetPrice: 4175.5 };
const alwaysOpen = () => true;
const base = { ...SHORT, firstExpectedOpen: T0, isSessionActive: alwaysOpen };

describe("followThrough", () => {
  it("resolves a target that takes far longer than a ten-minute window", () => {
    const quiet = Array.from({ length: 86 }, (_, index) => bar(index));
    const result = followThrough({ ...base, forwardCandles: [...quiet, bar(86, { low: 4175 })] });
    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.settlement.outcome).toBe("TARGET");
    expect(result.settlement.rMultiple).toBeCloseTo(1.5, 5);
    expect(result.settlement.barsToResolution).toBe(87);
    expect(result.settlement.resolvedTimeframe).toBe("1m");
    expect(result.settlement.resolverVersion).toBe(goldFollowThroughResolverVersion);
  });

  it("resolves a stop", () => {
    const result = followThrough({ ...base, forwardCandles: [bar(0), bar(1, { high: 4183.5 })] });
    expect(result.status).toBe("RESOLVED");
    if (result.status === "RESOLVED") {
      expect(result.settlement.outcome).toBe("STOP");
      expect(result.settlement.rMultiple!).toBeLessThanOrEqual(-1 + 1e-9);
    }
  });

  it("calls a bar spanning both levels a stop -- OHLC cannot order them", () => {
    const result = followThrough({ ...base, forwardCandles: [bar(0, { high: 4184, low: 4175 })] });
    expect(result.status === "RESOLVED" && result.settlement.outcome).toBe("STOP");
  });

  it("stays OPEN, writing nothing, while every bar is present and no level has been touched", () => {
    const result = followThrough({ ...base, forwardCandles: [bar(0), bar(1), bar(2)] });
    expect(result).toEqual({ status: "OPEN", barsObserved: 3 });
  });

  it("defers rather than guess when in-session minutes are missing before any touch", () => {
    // Bars 0-1, then the machine slept for 20 minutes, then bar 22 would have touched the target.
    const result = followThrough({ ...base, forwardCandles: [bar(0), bar(1), bar(22, { low: 4175 })] });
    expect(result.status).toBe("DEFERRED_GAP");
    if (result.status === "DEFERRED_GAP") expect(result.gapFrom.getTime()).toBe(T0.getTime() + 2 * MINUTE);
  });

  it("keeps a verdict reached before the hole: the stop cannot be un-hit by what is missing", () => {
    const result = followThrough({ ...base, forwardCandles: [bar(0), bar(1, { high: 4184 }), bar(30, { low: 4175 })] });
    expect(result.status === "RESOLVED" && result.settlement.outcome).toBe("STOP");
  });

  it("does not count a hole in a closed market (weekend, daily break) as missing data", () => {
    const closedAfterBar1 = (minute: Date) => minute.getTime() < T0.getTime() + 2 * MINUTE || minute.getTime() >= T0.getTime() + 22 * MINUTE;
    const result = followThrough({
      ...base, isSessionActive: closedAfterBar1,
      forwardCandles: [bar(0), bar(1), bar(22, { low: 4175 })],
    });
    expect(result.status === "RESOLVED" && result.settlement.outcome).toBe("TARGET");
  });

  it("defers when the very first expected bars are missing", () => {
    const result = followThrough({ ...base, forwardCandles: [bar(5)] });
    expect(result).toMatchObject({ status: "DEFERRED_GAP", barsObserved: 0 });
    if (result.status === "DEFERRED_GAP") expect(result.gapFrom.getTime()).toBe(T0.getTime());
  });

  it("is OPEN, not an error, with no bars yet and no way to know of a hole", () => {
    expect(followThrough({ ...base, forwardCandles: [] })).toEqual({ status: "OPEN", barsObserved: 0 });
  });
});

describe("reanchorBracket", () => {
  // The 2026-10-27 11:36 IST gold SHORT: shown 4006.95 / stop 4012.391822 / target 4000.06, filled at 4005.855.
  const shown = { side: "SHORT" as const, entryPrice: 4006.95, stopLoss: 4012.391822, targetPrice: 4000.06 };

  it("moves a short's stop and target with the fill, keeping risk and reward distances", () => {
    const levels = reanchorBracket(shown, 4005.855);
    expect(levels.entryPrice).toBe(4005.855);
    expect(levels.stopLoss).toBeCloseTo(4011.296822, 6);
    expect(levels.targetPrice).toBeCloseTo(3998.965, 6);
  });

  it("moves a long's stop below and target above the fill", () => {
    expect(reanchorBracket({ side: "LONG", entryPrice: 100, stopLoss: 98, targetPrice: 103 }, 101))
      .toEqual({ entryPrice: 101, stopLoss: 99, targetPrice: 104 });
  });

  it("settledLevels re-anchors a follow-through settlement and labels it", () => {
    const levels = settledLevels(shown, goldFollowThroughResolverVersion, 4005.855);
    expect(levels?.basis).toBe("REANCHORED");
    expect(levels?.stopLoss).toBeCloseTo(4011.296822, 6);
  });

  it("settledLevels reports the printed levels for the older bracket resolver", () => {
    expect(settledLevels(shown, "bracket-outcome-v1", null))
      .toEqual({ basis: "AS_SHOWN", entryPrice: 4006.95, stopLoss: 4012.391822, targetPrice: 4000.06 });
  });

  it("settledLevels refuses to guess when a re-anchored settlement has no readable fill bar", () => {
    expect(settledLevels(shown, goldFollowThroughResolverVersion, null)).toBeNull();
  });

  it("is the identity when the fill equals the idea's entry", () => {
    const levels = reanchorBracket(shown, shown.entryPrice);
    expect(levels.stopLoss).toBeCloseTo(shown.stopLoss, 9);
    expect(levels.targetPrice).toBeCloseTo(shown.targetPrice, 9);
  });
});
