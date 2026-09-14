import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import {
  computeIctSnapshotsForContexts,
  decorateContextsWithIct,
  deriveHtfBiasSeries,
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

  it("makes a higher-timeframe bucket visible only once it has closed", () => {
    // One session, four 5m bars. With 2 bars per bucket: bucket A = bars 0-1
    // (closes at bar 1's close), bucket B = bars 2-3 (closes at bar 3's close).
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-05", 9, 25, 101, 103, 100, 102),
      ctx("2026-01-05", 9, 30, 102, 104, 101, 103),
    ];
    const series = deriveHtfBiasSeries(contexts, 2);

    // Bar 0 closes before any bucket has closed -> no HTF bias visible yet.
    expect(series[0]).toBeUndefined();
    // Bar 1 closes at the same instant bucket A closes -> A is visible.
    expect(series[1]).toBeDefined();
    // Bar 2 is after A but before B closes -> still exactly A's reading.
    expect(series[2]).toBe(series[1]);
  });

  it("discards an incomplete session-end bucket instead of emitting a short bar", () => {
    // Session 1 has three bars: bucket A (bars 0-1) completes; bar 2 is a lone
    // partial that must be dropped when session 2 begins. Session 2 bar should
    // therefore still only ever see bucket A.
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-05", 9, 25, 101, 103, 100, 102), // lone partial in session 1
      ctx("2026-01-06", 9, 15, 102, 104, 101, 103), // session 2
    ];
    const series = deriveHtfBiasSeries(contexts, 2);
    // At the session-2 bar, only bucket A (from session 1) has ever closed; the
    // partial third bar of session 1 never formed a bucket.
    expect(series[3]).toBe(series[1]);
  });

  it("is prefix-invariant: the snapshot at bar i does not depend on later bars", () => {
    const contexts = [
      ctx("2026-01-05", 9, 15, 100, 101, 99, 100),
      ctx("2026-01-05", 9, 20, 100, 102, 99, 101),
      ctx("2026-01-05", 9, 25, 101, 103, 100, 102),
      ctx("2026-01-05", 9, 30, 102, 104, 101, 103),
      ctx("2026-01-05", 9, 35, 103, 105, 102, 104),
    ];
    const shortRun = computeIctSnapshotsForContexts(contexts.slice(0, 3), { htfBarsPerBucket: 2 });
    const longRun = computeIctSnapshotsForContexts(contexts, { htfBarsPerBucket: 2 });
    expect(JSON.stringify(longRun[2])).toBe(JSON.stringify(shortRun[2]));
  });

  it("leaves the HTF pillar uncovered when the base timeframe has no 60m mapping", () => {
    const contexts = [ctx("2026-01-05", 9, 15, 100, 101, 99, 100)].map((c) => ({
      ...c,
      candle: { ...c.candle, timeframe: "1d" },
    }));
    const snaps = computeIctSnapshotsForContexts(contexts);
    expect(snaps[0].coverage.htf).toBe("NOT_COVERED");
  });
});
