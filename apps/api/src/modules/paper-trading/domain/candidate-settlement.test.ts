import { describe, expect, it } from "vitest";
import { settleCandidate } from "./candidate-settlement.js";
import type { CompletedPriceCandle } from "./paper-trade-exit-policy.js";

/**
 * The settlement's job is to be honest about what it could not measure. Most of these cover that
 * rather than the resolution itself, which `resolveBracket` owns and tests separately.
 */

const SIGNAL = new Date("2026-08-18T05:00:00.000Z");
const HORIZON = new Date("2026-08-18T05:25:00.000Z"); // five 5-minute bars

function bar(minute: number, high: number, low: number): CompletedPriceCandle {
  const closeTime = new Date(SIGNAL.getTime() + minute * 60_000);
  return {
    id: `bar-${minute}`,
    openTime: new Date(closeTime.getTime() - 300_000),
    closeTime,
    open: 100,
    high,
    low,
    close: (high + low) / 2,
  };
}

const LONG = {
  side: "LONG" as const,
  entryPrice: 100,
  stopLoss: 90,
  targetPrice: 120,
  horizonEnd: HORIZON,
  resolvedTimeframe: "5m",
};

describe("settleCandidate", () => {
  it("settles a target inside the horizon", () => {
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 105, 99), bar(10, 121, 104)],
    });
    expect(settlement.outcome).toBe("TARGET");
    expect(settlement.barsToResolution).toBe(2);
    expect(settlement.rMultiple).toBeGreaterThan(0);
    expect(settlement.barsAvailable).toBe(2);
  });

  it("reports a fully observed horizon that never resolved as UNRESOLVED", () => {
    // A real timeout, and it belongs in the denominator: the whole window was seen and neither
    // barrier was touched.
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 105, 99), bar(10, 106, 98), bar(15, 104, 97), bar(20, 103, 96), bar(25, 102, 95)],
    });
    expect(settlement.outcome).toBe("UNRESOLVED");
    expect(settlement.rMultiple).toBeNull();
    expect(settlement.barsToResolution).toBeNull();
    expect(settlement.barsAvailable).toBe(5);
  });

  it("reports a partly observed horizon that never resolved as UNSETTLEABLE", () => {
    // The distinction that matters most. Calling this UNRESOLVED would turn every gap in the series
    // into evidence that the target was not reached, which is how a hit rate quietly collapses.
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 105, 99), bar(10, 106, 98)],
    });
    expect(settlement.outcome).toBe("UNSETTLEABLE");
    expect(settlement.barsAvailable).toBe(2);
    expect(settlement.maeR).toBeNull();
    expect(settlement.mfeR).toBeNull();
  });

  it("keeps a verdict reached inside the available bars, however short the series then runs", () => {
    // Bars four and five are missing, but the stop was hit on bar one. Missing later bars cannot
    // unhit it, so this is a settlement rather than a gap.
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 101, 89)],
    });
    expect(settlement.outcome).toBe("STOP");
    expect(settlement.barsToResolution).toBe(1);
  });

  it("treats no bars at all as unsettleable, not as a timeout", () => {
    const settlement = settleCandidate({ ...LONG, forwardCandles: [] });
    expect(settlement.outcome).toBe("UNSETTLEABLE");
    expect(settlement.barsAvailable).toBe(0);
  });

  it("ignores bars that close after the horizon", () => {
    // The vertical barrier cuts the window. Crediting a target from a bar past expiry would report an
    // outcome the position was never open for.
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [
        bar(5, 105, 99), bar(10, 106, 98), bar(15, 104, 97), bar(20, 103, 96), bar(25, 102, 95),
        bar(30, 130, 101), // past the horizon: a target, and it must not count
      ],
    });
    expect(settlement.outcome).toBe("UNRESOLVED");
    expect(settlement.barsAvailable).toBe(5);
  });

  it("measures excursions only over the bars the position was alive for", () => {
    // Stopped on bar two; bar three runs to 118. Including it would report 1.8R in favour for a
    // position that had already closed.
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 104, 99), bar(10, 105, 89), bar(15, 118, 100)],
    });
    expect(settlement.outcome).toBe("STOP");
    expect(settlement.barsToResolution).toBe(2);
    // Best over bars one and two is 105, i.e. 0.5R, not the 1.8R that bar three would have added.
    expect(settlement.mfeR).toBeCloseTo(0.5, 6);
    expect(settlement.maeR).toBeCloseTo(1.1, 6);
  });

  it("measures excursions over the whole horizon when nothing resolved", () => {
    const settlement = settleCandidate({
      ...LONG,
      forwardCandles: [bar(5, 108, 99), bar(10, 106, 94), bar(15, 104, 97), bar(20, 103, 96), bar(25, 102, 95)],
    });
    expect(settlement.outcome).toBe("UNRESOLVED");
    expect(settlement.mfeR).toBeCloseTo(0.8, 6);
    expect(settlement.maeR).toBeCloseTo(0.6, 6);
  });

  it("settles a SHORT with the sides reversed", () => {
    const settlement = settleCandidate({
      side: "SHORT",
      entryPrice: 100,
      stopLoss: 110,
      targetPrice: 80,
      horizonEnd: HORIZON,
      resolvedTimeframe: "5m",
      forwardCandles: [bar(5, 101, 95), bar(10, 99, 79)],
    });
    expect(settlement.outcome).toBe("TARGET");
    expect(settlement.rMultiple).toBeGreaterThan(0);
  });

  it("stamps the resolver version so a semantics change is attributable", () => {
    const settlement = settleCandidate({ ...LONG, forwardCandles: [bar(5, 121, 99)] });
    expect(settlement.resolverVersion).toBe("bracket-outcome-v1");
  });

  it("refuses an unusable horizon", () => {
    expect(() => settleCandidate({ ...LONG, horizonEnd: new Date("nope"), forwardCandles: [] }))
      .toThrow(/valid horizon end/);
  });
});
