import { describe, expect, it } from "vitest";
import { breakEvenHitRate, resolveBracket } from "./bracket-outcome.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";

let sequence = 0;
function bar(open: number, high: number, low: number, close: number): CompletedPriceCandle {
  sequence += 1;
  return {
    id: `bar-${sequence}`,
    openTime: new Date(Date.UTC(2026, 0, 1, 0, sequence)),
    closeTime: new Date(Date.UTC(2026, 0, 1, 0, sequence + 1)),
    open, high, low, close,
  };
}

/** A 2:1 long from 100: stop 90, target 120. */
const LONG = { side: "LONG" as const, entryPrice: 100, stopLoss: 90, targetPrice: 120 };
/** Its mirror: short from 100, stop 110, target 80. */
const SHORT = { side: "SHORT" as const, entryPrice: 100, stopLoss: 110, targetPrice: 80 };

describe("resolveBracket", () => {
  it("reports a target hit with its bar count and R multiple", () => {
    const result = resolveBracket(LONG, [bar(100, 105, 98, 104), bar(104, 121, 103, 120)]);
    expect(result.outcome).toBe("TARGET");
    expect(result.barsToResolution).toBe(2);
    expect(result.rMultiple).toBeCloseTo(2, 6);
  });

  it("reports a stop hit at -1R", () => {
    const result = resolveBracket(LONG, [bar(100, 102, 89, 91)]);
    expect(result.outcome).toBe("STOP");
    expect(result.rMultiple).toBeCloseTo(-1, 6);
  });

  it("resolves a bar spanning both levels as a stop, never a target", () => {
    // The single easiest way to manufacture an edge is to call this a win. OHLC cannot order the
    // two touches, so the conservative answer is the only defensible one.
    const result = resolveBracket(LONG, [bar(100, 125, 85, 100)]);
    expect(result.outcome).toBe("STOP");
  });

  it("fills a gap at the open, so a gapped stop can exceed -1R", () => {
    // A fixed -1 assumption hides exactly this tail.
    const result = resolveBracket(LONG, [bar(80, 82, 78, 79)]);
    expect(result.outcome).toBe("STOP");
    expect(result.rMultiple).toBeCloseTo(-2, 6);
  });

  it("credits a favourable gap at what it actually paid", () => {
    const result = resolveBracket(LONG, [bar(130, 132, 129, 131)]);
    expect(result.outcome).toBe("TARGET");
    expect(result.rMultiple).toBeCloseTo(3, 6);
  });

  it("returns UNRESOLVED rather than folding an open bracket into either bucket", () => {
    const result = resolveBracket(LONG, [bar(100, 105, 96, 101), bar(101, 106, 97, 102)]);
    expect(result.outcome).toBe("UNRESOLVED");
    expect(result.barsToResolution).toBeNull();
    expect(result.rMultiple).toBeNull();
  });

  it("is symmetric: the mirrored bracket on mirrored bars gives the mirrored result", () => {
    const longWin = resolveBracket(LONG, [bar(100, 121, 99, 120)]);
    const shortWin = resolveBracket(SHORT, [bar(100, 101, 79, 80)]);
    expect(longWin.outcome).toBe("TARGET");
    expect(shortWin.outcome).toBe("TARGET");
    expect(shortWin.rMultiple).toBeCloseTo(longWin.rMultiple!, 6);
  });

  it("refuses a degenerate bracket instead of dividing by zero risk", () => {
    expect(() => resolveBracket({ ...LONG, stopLoss: 100 }, [])).toThrow(/risk distance/i);
    expect(() => resolveBracket({ ...LONG, targetPrice: 100 }, [])).toThrow(/reward distance/i);
  });
});

describe("breakEvenHitRate", () => {
  it("is one third at 2:1", () => {
    expect(breakEvenHitRate(2)).toBeCloseTo(1 / 3, 10);
  });

  it("rises as the reward multiple shrinks", () => {
    expect(breakEvenHitRate(1)).toBeCloseTo(0.5, 10);
    expect(breakEvenHitRate(3)).toBeCloseTo(0.25, 10);
    expect(breakEvenHitRate(1)).toBeGreaterThan(breakEvenHitRate(3));
  });

  it("refuses a non-positive multiple", () => {
    expect(() => breakEvenHitRate(0)).toThrow(/positive/i);
  });
});
