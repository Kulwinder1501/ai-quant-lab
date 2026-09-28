import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import {
  computeIctSnapshotsForContexts,
  decorateContextsWithIct,
  deriveHtfBiasSeries,
  deriveHtfBiasSeriesFromCandles,
  type HtfSourceCandle,
} from "./replay-builder.js";

let seq = 0;
function ctx(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
): StrategyMarketContext {
  const [y, m, d] = dateStr.split("-").map(Number);
  const istMinutes = hour * 60 + minute;
  const utcMinutes = istMinutes - 330;
  const openTime = new Date(Date.UTC(y, m - 1, d, 0, utcMinutes));
  const closeTime = new Date(openTime.getTime() + 5 * 60_000);
  seq += 1;
  return {
    candle: {
      id: `c-${dateStr}-${hour}-${minute}-${seq}`,
      instrumentId: "inst-1",
      timeframe: "5m",
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 100,
      tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

let candleSeq = 0;
function candle(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
): HtfSourceCandle {
  const [y, m, d] = dateStr.split("-").map(Number);
  const istMinutes = hour * 60 + minute;
  const utcMinutes = istMinutes - 330;
  const openTime = new Date(Date.UTC(y, m - 1, d, 0, utcMinutes));
  const closeTime = new Date(openTime.getTime() + 5 * 60_000);
  candleSeq += 1;
  return {
    id: `candle-${dateStr}-${hour}-${minute}-${candleSeq}`,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

describe("ICT replay builder", () => {
  it("attaches a causal snapshot to every context, aligned by bar index", () => {
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 110, 95, 105),
      ctx("2026-01-05", 9, 20, 105, 112, 104, 108),
      ctx("2026-01-06", 9, 15, 106, 107, 93, 97),
    ];
    const decorated = decorateContextsWithIct(contexts);
    expect(decorated).toHaveLength(3);
    decorated.forEach((c, i) => {
      expect(c.ictSnapshot).toBeDefined();
      expect(c.ictSnapshot?.barIndex).toBe(i);
      // The base contexts are copied, not mutated.
      expect(contexts[i].ictSnapshot).toBeUndefined();
    });
  });

  it("makes the daily HTF candle visible only once its session has closed", () => {
    // Two sessions of two 5m bars each. Session 1 becomes a complete daily candle only when the
    // first bar of session 2 arrives, so nothing inside session 1 can see it.
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-06", 9, 15, 101, 103, 100, 102),
      ctx("2026-01-06", 9, 20, 102, 104, 101, 103),
    ];
    const series = deriveHtfBiasSeries(contexts);

    // Mid-session-1: no session has completed, so there is no daily candle at all.
    expect(series[0]).toBeUndefined();
    // The LAST bar of session 1 closes at the same instant session 1's daily candle does, so it is
    // visible to it. Simultaneous, not lookahead -- the same convention the bucket rule always used.
    expect(series[1]).toBeDefined();
    // The first bar of session 2 still sees only session 1: session 2 has not closed.
    expect(series[2]).toBe(series[1]);
  });

  it("never emits the still-forming final session as a daily candle", () => {
    // Three sessions. The third is trailing, so only sessions 1 and 2 can ever become candles --
    // a bar inside session 3 must not see session 3.
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-06", 9, 15, 100, 102, 99, 101),
      ctx("2026-01-06", 9, 20, 101, 103, 100, 102),
      ctx("2026-01-07", 9, 15, 101, 103, 100, 102),
    ];
    const series = deriveHtfBiasSeries(contexts);
    // Growing the trailing session cannot change what any earlier bar saw. If the still-forming
    // session were ever emitted, these would move.
    const extended = deriveHtfBiasSeries([...contexts, ctx("2026-01-07", 9, 20, 102, 104, 101, 103)]);
    for (let i = 0; i < contexts.length; i += 1) {
      expect(extended[i]).toBe(series[i]);
    }
    // And the first bar of the run still sees nothing: no session had completed before it.
    expect(series[0]).toBeUndefined();
  });

  it("is prefix-invariant: the snapshot at bar i does not depend on later bars", () => {
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-06", 9, 15, 101, 103, 100, 102),
      ctx("2026-01-06", 9, 20, 102, 104, 101, 103),
      ctx("2026-01-07", 9, 15, 103, 105, 102, 104),
    ];
    const shortRun = computeIctSnapshotsForContexts(contexts.slice(0, 3));
    const longRun = computeIctSnapshotsForContexts(contexts);
    expect(JSON.stringify(longRun[2])).toBe(JSON.stringify(shortRun[2]));
  });

  it("leaves the HTF pillar uncovered when the window holds fewer than two sessions", () => {
    // Replaces the old "no 60m mapping" case. Bucketing is no longer keyed on the base timeframe at
    // all, so the only way to have no daily candle is to have no completed session.
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
    ];
    const snaps = computeIctSnapshotsForContexts(contexts);
    expect(snaps[0].coverage.htf).toBe("NOT_COVERED");
    expect(snaps[1].coverage.htf).toBe("NOT_COVERED");
  });
});

describe("deriveHtfBiasSeriesFromCandles (candle-array input, no StrategyMarketContext)", () => {
  it("makes the daily HTF candle visible only once its session has closed", () => {
    // Same scenario as the context-based equivalent above, but driven directly off plain candles --
    // this is exactly the shape the live path (postgres-strategy-market-context-repository) has on
    // hand, with no StrategyMarketContext wrapping available.
    const candles = [
      candle("2026-01-05", 9, 15, 100, 101, 99, 100),
      candle("2026-01-05", 9, 20, 100, 102, 99, 101),
      candle("2026-01-06", 9, 15, 101, 103, 100, 102),
      candle("2026-01-06", 9, 20, 102, 104, 101, 103),
    ];
    const series = deriveHtfBiasSeriesFromCandles(candles);

    // Mid-session-1: no session has completed, so there is no daily candle at all.
    expect(series[0]).toBeUndefined();
    // The LAST bar of session 1 closes at the same instant session 1's daily candle does, so it is
    // visible to it. Simultaneous, not lookahead -- the same convention the bucket rule always used.
    expect(series[1]).toBeDefined();
    // The first bar of session 2 still sees only session 1: session 2 has not closed.
    expect(series[2]).toBe(series[1]);
  });

  it("never emits the still-forming final session as a daily candle", () => {
    // Three sessions. The third is trailing, so only sessions 1 and 2 can ever become candles --
    // a bar inside session 3 must not see session 3.
    const candles = [
      candle("2026-01-05", 9, 15, 100, 101, 99, 100),
      candle("2026-01-05", 9, 20, 100, 102, 99, 101),
      candle("2026-01-06", 9, 15, 100, 102, 99, 101),
      candle("2026-01-06", 9, 20, 101, 103, 100, 102),
      candle("2026-01-07", 9, 15, 101, 103, 100, 102),
    ];
    const series = deriveHtfBiasSeriesFromCandles(candles);
    // Growing the trailing session cannot change what any earlier bar saw. If the still-forming
    // session were ever emitted, these would move.
    const extended = deriveHtfBiasSeriesFromCandles([
      ...candles,
      candle("2026-01-07", 9, 20, 102, 104, 101, 103),
    ]);
    for (let i = 0; i < candles.length; i += 1) {
      expect(extended[i]).toBe(series[i]);
    }
    // And the first bar of the run still sees nothing: no session had completed before it.
    expect(series[0]).toBeUndefined();
  });

  it("accumulates multiple completed sessions correctly, moving the visible bucket forward each time", () => {
    // Four sessions of two bars each -- the third and fourth session's bars should each see a more
    // recent completed daily bucket than the one before it, strictly advancing (never resetting to
    // undefined and never skipping a session).
    const candles = [
      candle("2026-01-05", 9, 15, 100, 101, 99, 100),
      candle("2026-01-05", 9, 20, 100, 102, 99, 101),
      candle("2026-01-06", 9, 15, 101, 103, 100, 102),
      candle("2026-01-06", 9, 20, 102, 104, 101, 103),
      candle("2026-01-07", 9, 15, 103, 105, 102, 104),
      candle("2026-01-07", 9, 20, 104, 106, 103, 105),
      candle("2026-01-08", 9, 15, 105, 107, 104, 106),
      candle("2026-01-08", 9, 20, 106, 108, 105, 107),
    ];
    const series = deriveHtfBiasSeriesFromCandles(candles);

    // No session has closed before session 1 starts.
    expect(series[0]).toBeUndefined();
    // Session 1 closes on its own last bar and becomes visible there and to session 2's first bar.
    expect(series[1]).toBeDefined();
    expect(series[2]).toBe(series[1]);
    // Session 2 closes on its own last bar (index 3), which is visible from index 3 onward, and is a
    // distinct bucket from session 1's (a fresh HTF engine step, not the same cached value).
    expect(series[3]).toBeDefined();
    expect(series[4]).toBe(series[3]);
    // Session 3 closes at index 5, visible from index 5 onward.
    expect(series[5]).toBeDefined();
    expect(series[6]).toBe(series[5]);
    expect(series[7]).toBe(series[5]);
  });

  it("is equivalent to deriveHtfBiasSeries on the same underlying candles", () => {
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-06", 9, 15, 101, 103, 100, 102),
      ctx("2026-01-06", 9, 20, 102, 104, 101, 103),
    ];
    const viaContexts = deriveHtfBiasSeries(contexts);
    const viaCandles = deriveHtfBiasSeriesFromCandles(contexts.map((c) => c.candle));
    expect(viaCandles).toEqual(viaContexts);
  });
});
