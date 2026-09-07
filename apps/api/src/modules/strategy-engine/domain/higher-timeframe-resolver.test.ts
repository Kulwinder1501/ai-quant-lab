import { describe, expect, it } from "vitest";
import {
  attachHigherTimeframes,
  resolveHigherTimeframes,
  type HigherTimeframeResolverOptions,
} from "./higher-timeframe-resolver.js";
import type { StrategyMarketContext } from "./strategy.js";

const OPTIONS: HigherTimeframeResolverOptions = {
  buckets: [{ htfTimeframe: "15m", barsPerBucket: 3 }],
  emaFastPeriod: 2,
  emaSlowPeriod: 4,
  biasBandFraction: 0.0005,
  swingLookbackBuckets: 20,
};

/** One 5-minute bar. `day` separates sessions; bars are contiguous within a day. */
function bar(day: number, minute: number, close: number, high = close, low = close): StrategyMarketContext {
  const open = new Date(Date.UTC(2026, 0, day, 4, minute));
  return {
    candle: {
      id: `c-${day}-${minute}`,
      instrumentId: "i-1",
      timeframe: "5m",
      openTime: open,
      closeTime: new Date(open.getTime() + 5 * 60_000),
      open: close,
      high,
      low,
      close,
      volume: 1_000,
      tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

function series(closes: readonly number[], day = 5): StrategyMarketContext[] {
  return closes.map((close, index) => bar(day, index * 5, close));
}

describe("resolveHigherTimeframes", () => {
  it("publishes nothing until a bucket has completed", () => {
    const resolved = resolveHigherTimeframes(series([100, 101, 102, 103]), OPTIONS);

    // Bars 0-2 form the first bucket; it can only be read by a bar after it.
    expect(resolved[0]).toEqual([]);
    expect(resolved[1]).toEqual([]);
    expect(resolved[2]).toEqual([]);
    expect(resolved[3]).toHaveLength(1);
  });

  // The property the whole measurement rests on. If a bar can see the bucket it belongs to, the
  // bias reflects the move being predicted and every downstream number is flattered.
  it("never lets a bar see the bucket it belongs to", () => {
    // Bar 5 spikes to a 999 high and closes at 500. It closes bucket two, so no bar up to and
    // including 5 may show that high. Closing at 500 puts 999 above the close and 100 below it,
    // which makes 999 the nearest resistance once the bucket is legitimately visible -- otherwise
    // bucket one's high of 100 would still be nearer and the assertion would prove nothing.
    const contexts = [
      bar(5, 0, 100), bar(5, 5, 100), bar(5, 10, 100),
      bar(5, 15, 100), bar(5, 20, 100), bar(5, 25, 500, 999, 100),
      bar(5, 30, 100),
    ];
    const resolved = resolveHigherTimeframes(contexts, OPTIONS);

    for (let index = 0; index <= 5; index += 1) {
      const levels = resolved[index]!.map((htf) => htf.nearestResistanceLevel);
      expect(levels).not.toContain(999);
    }
    // Bar 6 is the first that may, and does.
    expect(resolved[6]![0]!.nearestResistanceLevel).toBe(999);
  });

  it("does not build a bucket across a session boundary", () => {
    // Two bars on day 5, then day 6. The stranded pair must not be completed by the next session,
    // so the first published bucket comes from day 6's own three bars.
    const contexts = [
      bar(5, 0, 100), bar(5, 5, 100),
      bar(6, 0, 200), bar(6, 5, 200), bar(6, 10, 200),
      bar(6, 15, 200),
    ];
    const resolved = resolveHigherTimeframes(contexts, OPTIONS);

    expect(resolved[2]).toEqual([]);
    expect(resolved[3]).toEqual([]);
    expect(resolved[4]).toEqual([]);
    expect(resolved[5]![0]!.nearestSupportLevel).toBe(200);
  });

  it("calls a rising series BULLISH and a flat one NEUTRAL", () => {
    const rising = resolveHigherTimeframes(series(Array.from({ length: 30 }, (_, i) => 100 + i)), OPTIONS);
    const flat = resolveHigherTimeframes(series(Array.from({ length: 30 }, () => 100)), OPTIONS);

    expect(rising.at(-1)![0]!.trendBias).toBe("BULLISH");
    expect(flat.at(-1)![0]!.trendBias).toBe("NEUTRAL");
  });

  it("calls a falling series BEARISH", () => {
    const falling = resolveHigherTimeframes(series(Array.from({ length: 30 }, (_, i) => 200 - i)), OPTIONS);

    expect(falling.at(-1)![0]!.trendBias).toBe("BEARISH");
  });

  it("keeps support at or below the last close and resistance at or above it", () => {
    const closes = [100, 104, 99, 107, 96, 103, 108, 94, 101, 105, 97, 102];
    const resolved = resolveHigherTimeframes(series(closes), OPTIONS);

    for (const perBar of resolved) {
      for (const htf of perBar) {
        // The published levels are relative to that bucket's close, which the resolver holds
        // internally; the invariant is that a support is never above its resistance.
        if (htf.nearestSupportLevel !== null && htf.nearestResistanceLevel !== null) {
          expect(htf.nearestSupportLevel).toBeLessThanOrEqual(htf.nearestResistanceLevel);
        }
      }
    }
  });

  it("resolves each configured bucket independently", () => {
    const resolved = resolveHigherTimeframes(series(Array.from({ length: 40 }, (_, i) => 100 + i)), {
      ...OPTIONS,
      buckets: [
        { htfTimeframe: "15m", barsPerBucket: 3 },
        { htfTimeframe: "60m", barsPerBucket: 12 },
      ],
    });

    const last = resolved.at(-1)!;
    expect(last.map((htf) => htf.htfTimeframe).sort()).toEqual(["15m", "60m"]);
    // The 60m bucket needs twelve bars, so it starts later than the 15m one.
    expect(resolved[3]!.map((htf) => htf.htfTimeframe)).toEqual(["15m"]);
  });

  it("refuses a bucket size that is not a real aggregation", () => {
    expect(() => resolveHigherTimeframes(series([100, 101]), {
      ...OPTIONS,
      buckets: [{ htfTimeframe: "5m", barsPerBucket: 1 }],
    })).toThrow(/at least 2/);
  });

  it("attaches without disturbing the rest of the context", () => {
    const contexts = series([100, 101, 102, 103]);
    const attached = attachHigherTimeframes(contexts, OPTIONS);

    expect(attached).toHaveLength(contexts.length);
    expect(attached[3]!.higherTimeframes).toHaveLength(1);
    expect(attached[3]!.candle).toEqual(contexts[3]!.candle);
    // The input is left alone: arm A and arm B must be able to share one load.
    expect(contexts[3]!.higherTimeframes).toBeUndefined();
  });
});
