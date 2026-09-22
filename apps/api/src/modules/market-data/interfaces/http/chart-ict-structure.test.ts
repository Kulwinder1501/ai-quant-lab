import { describe, expect, it } from "vitest";
import { toChartIctStructure } from "./market-data.routes.js";
import type { IctStructureSnapshot } from "../../../technical-analysis/domain/ict/structure.js";
import type { ConfirmedPivot } from "../../../technical-analysis/domain/ict/causal-pivot.js";

function pivot(index: number, price: number, type: "HIGH" | "LOW"): ConfirmedPivot {
  return {
    index,
    time: new Date(Date.UTC(2026, 8, 22, 3, 45 + index)),
    price,
    type,
    confirmedAtIndex: index + 2,
    confirmedAtTime: new Date(Date.UTC(2026, 8, 22, 3, 47 + index)),
  };
}

function snapshot(overrides: Partial<IctStructureSnapshot> = {}): IctStructureSnapshot {
  return {
    trend: "BEARISH",
    lastHH: null,
    lastHL: null,
    lastLL: null,
    lastLH: null,
    idm: null,
    bosLevel: null,
    chochLevel: null,
    internalVsExternal: "EXTERNAL",
    lastEvent: null,
    confirmedPivotCount: 0,
    ...overrides,
  };
}

describe("toChartIctStructure", () => {
  it("returns null when no structure snapshot exists, matching the zone arrays' absence contract", () => {
    expect(toChartIctStructure(null)).toBeNull();
    expect(toChartIctStructure(undefined)).toBeNull();
  });

  /*
   * The defect this projection exists to avoid, found by running the mapping against live snapshots:
   * a bearish CHoCH sets `lastLH = lastHH` and never clears `lastHH`, so the SAME pivot arrives under
   * both labels. NIFTY50 5m and 15m each reported HH and LH as pivot 23489 @ 03:45. Drawn on a chart
   * that is two contradictory labels on one candle.
   */
  it("emits one label per pivot when a bearish CHoCH left the same swing as both HH and LH", () => {
    const shared = pivot(10, 23489, "HIGH");
    const result = toChartIctStructure(snapshot({
      trend: "BEARISH",
      lastHH: shared,
      lastLH: shared,
      lastLL: pivot(4, 23193.65, "LOW"),
    }));

    expect(result?.swings).toHaveLength(2);
    // The downtrend's own frame wins: that swing is the LH the structure is working against.
    expect(result?.swings.map((s) => s.label).sort()).toEqual(["LH", "LL"]);
    expect(result?.swings.find((s) => s.label === "LH")?.price).toBe(23489);
    expect(result?.swings.some((s) => s.label === "HH")).toBe(false);
  });

  it("prefers the uptrend labels when the same pivot is shared in a BULLISH frame", () => {
    const shared = pivot(7, 100, "LOW");
    const result = toChartIctStructure(snapshot({ trend: "BULLISH", lastHL: shared, lastLL: shared }));

    expect(result?.swings).toHaveLength(1);
    expect(result?.swings[0].label).toBe("HL");
  });

  it("keeps genuinely distinct swings even when their prices coincide", () => {
    // Same price, different candles -- two real swings, not one duplicated. Index is the identity.
    const result = toChartIctStructure(snapshot({
      trend: "BEARISH",
      lastLH: pivot(3, 500, "HIGH"),
      lastHH: pivot(9, 500, "HIGH"),
    }));

    expect(result?.swings).toHaveLength(2);
    expect(result?.swings.map((s) => s.label)).toEqual(["LH", "HH"]);
  });

  it("anchors each swing to the candle that made the extreme, not the bar that confirmed it", () => {
    const swing = pivot(5, 200, "LOW");
    const result = toChartIctStructure(snapshot({ trend: "BULLISH", lastHL: swing }));

    expect(result?.swings[0].timestamp).toBe(swing.time.toISOString());
    expect(result?.swings[0].timestamp).not.toBe(swing.confirmedAtTime.toISOString());
  });

  it("carries idm, the BOS/CHoCH levels and the last event through", () => {
    const result = toChartIctStructure(snapshot({
      trend: "BEARISH",
      idm: pivot(12, 23403.1, "HIGH"),
      bosLevel: 23193.65,
      chochLevel: 23489,
      lastEvent: {
        type: "BOS",
        direction: "BEARISH",
        level: 23193.65,
        candleIndex: 20,
        candleTime: new Date(Date.UTC(2026, 8, 22, 8, 50)),
        brokenPivot: pivot(4, 23193.65, "LOW"),
        isWickOnly: false,
      },
    }));

    expect(result?.idm).toEqual({ price: 23403.1, timestamp: pivot(12, 23403.1, "HIGH").time.toISOString() });
    expect(result?.bosLevel).toBe(23193.65);
    expect(result?.chochLevel).toBe(23489);
    expect(result?.lastEvent?.type).toBe("BOS");
    expect(result?.lastEvent?.isWickOnly).toBe(false);
    expect(result?.lastEvent?.timestamp).toBe(new Date(Date.UTC(2026, 8, 22, 8, 50)).toISOString());
  });

  /*
   * A snapshot that round-tripped through `ict_state_snapshots.snapshot_payload` hands back ISO
   * strings where the type says `Date` -- jsonb has no Date type. The projection must survive that,
   * since a cache hit is the common case on a live chart.
   */
  it("accepts ISO-string timestamps from a jsonb round-trip, not just real Dates", () => {
    const roundTripped = {
      ...pivot(6, 300, "LOW"),
      time: new Date(Date.UTC(2026, 8, 22, 4, 0)).toISOString() as unknown as Date,
    };
    const result = toChartIctStructure(snapshot({ trend: "BULLISH", lastHL: roundTripped }));

    expect(result?.swings[0].timestamp).toBe(new Date(Date.UTC(2026, 8, 22, 4, 0)).toISOString());
  });
});
