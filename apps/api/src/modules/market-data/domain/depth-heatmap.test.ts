import { describe, expect, it } from "vitest";
import {
  buildDepthHeatmap,
  HEATMAP_CAP_PERCENTILE,
  percentile,
  type HeatmapCell,
} from "./depth-heatmap.js";
import type { StoredDepthFrame } from "./depth-ladder.js";

/** 2026-10-12 is a Monday; 10:00 IST = 04:30Z. */
const MON_1000_IST = new Date("2026-10-12T04:30:00.000Z");
const at = (seconds: number) => new Date(MON_1000_IST.getTime() + seconds * 1000);

/**
 * Synthetic books, hand-built for the arithmetic below (not recorded from the feed), on a one-point tick so every
 * bin can be worked out by eye. Default: bids 100..96, asks 110..114.
 */
function frame(receivedAt: Date, overrides: Partial<StoredDepthFrame> = {}): StoredDepthFrame {
  return {
    providerSymbol: "NSE:BANKNIFTY26OCTFUT",
    sequenceNo: 1,
    exchangeFeedTime: 1_792_000_000,
    receivedAt,
    isSnapshot: false,
    levelsStored: 5,
    levelsAvailable: 50,
    bidPrice: [100, 99, 98, 97, 96],
    bidQty: [10, 20, 30, 40, 50],
    bidOrders: [1, 1, 1, 1, 1],
    askPrice: [110, 111, 112, 113, 114],
    askQty: [5, 15, 25, 35, 45],
    askOrders: [1, 1, 1, 1, 1],
    totalBuyQty: 42_000,
    totalSellQty: 42_000,
    gapBefore: 0,
    isDuplicate: false,
    captureSessionId: "session-1",
    ...overrides,
  };
}

const byRow = (cells: readonly HeatmapCell[]) => Object.fromEntries(cells.map((c) => [c[1], c]));

describe("buildDepthHeatmap: which bins a frame covers", () => {
  it("emits each bin that lies entirely inside the span the stored levels describe, with the quantity resting in it", () => {
    const heatmap = buildDepthHeatmap([frame(at(0))], { rowPoints: 2 });
    const rows = byRow(heatmap.cells);
    // Bins are 2 points: row r is [2r, 2r+2). Span is 96..114, so rows 48 (96-98) .. 56 (112-114).
    expect(Object.keys(rows).map(Number)).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56]);
    expect(rows[48]!.slice(2, 4)).toEqual([90, 0]);  // bids at 96 (50) and 97 (40)
    expect(rows[49]!.slice(2, 4)).toEqual([50, 0]);  // bids at 98 (30) and 99 (20)
    expect(rows[50]!.slice(2, 4)).toEqual([10, 0]);  // the best bid, 100
    expect(rows[55]!.slice(2, 4)).toEqual([0, 20]);  // asks at 110 (5) and 111 (15)
    expect(rows[56]!.slice(2, 4)).toEqual([0, 60]);  // asks at 112 (25) and 113 (35)
  });

  it("draws the spread as a real zero: known and empty", () => {
    const rows = byRow(buildDepthHeatmap([frame(at(0))], { rowPoints: 2 }).cells);
    for (const row of [51, 52, 53, 54]) expect(rows[row]!.slice(2, 4)).toEqual([0, 0]);
  });

  it("leaves a bin the frame could not see absent, never zero, including the bin the deepest ask sits in", () => {
    const rows = byRow(buildDepthHeatmap([frame(at(0))], { rowPoints: 2 }).cells);
    expect(rows[47]).toBeUndefined();  // below the deepest stored bid
    expect(rows[57]).toBeUndefined();  // holds the deepest ask (114) but extends past it: not fully covered
    expect(rows[58]).toBeUndefined();
  });

  it("covers fewer bins at a coarser row height, and none that straddle the edge of the known span", () => {
    // 5-point bins: [100,105) is covered; [105,110) is covered; [110,115) extends past 114, so it is not.
    const heatmap = buildDepthHeatmap([frame(at(0))], { rowPoints: 5 });
    expect(heatmap.cells.map((c) => c[1])).toEqual([20, 21]);
    expect(heatmap.cells[0]!.slice(2, 4)).toEqual([10, 0]);
    expect(heatmap.cells[1]!.slice(2, 4)).toEqual([0, 0]);
  });

  it("reports the occupied bin range and nothing for an empty grid", () => {
    expect(buildDepthHeatmap([frame(at(0))], { rowPoints: 2 }).rowRange).toEqual({ low: 48, high: 56 });
    const none = buildDepthHeatmap([]);
    expect(none.rowRange).toBeNull();
    expect(none.cells).toEqual([]);
    expect(none.scale).toMatchObject({ capQty: null, maxQty: null, cellsWithLiquidity: 0 });
  });
});

describe("buildDepthHeatmap: averaging across frames in a bucket", () => {
  const deeper = frame(at(1), {
    levelsStored: 7,
    bidPrice: [100, 99, 98, 97, 96, 95, 94],
    bidQty: [10, 10, 10, 10, 10, 10, 10],
    bidOrders: [1, 1, 1, 1, 1, 1, 1],
  });

  it("averages over the frames that covered the bin, and counts them", () => {
    const rows = byRow(buildDepthHeatmap([frame(at(0)), deeper], { rowPoints: 2 }).cells);
    // Row 48: first frame holds 90, the deeper frame 20 -> mean 55 over 2 frames.
    expect(rows[48]!.slice(2)).toEqual([55, 0, 2]);
  });

  it("does not dilute a bin with the frames that could not see it", () => {
    const rows = byRow(buildDepthHeatmap([frame(at(0)), deeper], { rowPoints: 2 }).cells);
    // Row 47 (94-96) is covered only by the deeper frame: its own 20, not (0 + 20) / 2.
    expect(rows[47]!.slice(2)).toEqual([20, 0, 1]);
  });

  it("keeps the bid and ask quantity apart when a price changes sides between frames", () => {
    // The best bid becomes an ask at the same price level in the second frame.
    const flipped = frame(at(1), {
      bidPrice: [90, 89, 88, 87, 86], askPrice: [100, 101, 102, 103, 104], askQty: [10, 5, 5, 5, 5],
    });
    const rows = byRow(buildDepthHeatmap([frame(at(0)), flipped], { rowPoints: 2 }).cells);
    // Row 50 [100,102): first frame has bid 10, ask 0; second has bid 0, ask 10 + 5 = 15. Both cover it.
    const cell = rows[50];
    expect(cell).toBeDefined();
    expect(cell![2]).toBe(5);    // mean bid (10 + 0) / 2
    expect(cell![3]).toBe(7.5);  // mean ask (0 + 15) / 2
    expect(cell![4]).toBe(2);
  });
});

describe("buildDepthHeatmap: frames that must not contribute", () => {
  it("ignores a crossed book entirely, but still counts it in its bucket", () => {
    const crossed = frame(at(0), { askPrice: [95, 96, 97, 98, 99] });
    const heatmap = buildDepthHeatmap([crossed], { rowPoints: 2 });
    expect(heatmap.cells).toEqual([]);
    expect(heatmap.buckets[0]).toMatchObject({ frames: 1, usableFrames: 0, mid: null });
    expect(heatmap.counts).toEqual({ framesInSession: 1, framesUsed: 0, framesWithoutLevelMetrics: 1 });
  });

  it("ignores a frame from the pre-2026-09-07 capture regime", () => {
    const old = frame(new Date("2026-09-02T04:30:00.000Z"));
    expect(buildDepthHeatmap([old]).cells).toEqual([]);
  });

  it("leaves out frames outside Mon-Fri 09:00-15:30 IST", () => {
    const heatmap = buildDepthHeatmap([frame(new Date("2026-10-17T04:30:00.000Z")), frame(new Date("2026-10-12T03:00:00.000Z"))]);
    expect(heatmap.buckets).toEqual([]);
    expect(heatmap.counts.framesInSession).toBe(0);
  });
});

describe("buildDepthHeatmap: buckets, mid and scale", () => {
  it("buckets on epoch-aligned boundaries and reports the median mid of the usable frames", () => {
    const wide = frame(at(1), { askPrice: [120, 121, 122, 123, 124] });
    const heatmap = buildDepthHeatmap([frame(at(0)), wide, frame(at(61))], { bucketSeconds: 60 });
    expect(heatmap.buckets.map((b) => [b.t, b.frames, b.usableFrames])).toEqual([
      ["2026-10-12T04:30:00.000Z", 2, 2],
      ["2026-10-12T04:31:00.000Z", 1, 1],
    ]);
    // Mids: (100+110)/2 = 105 and (100+120)/2 = 110 -> median 107.5.
    expect(heatmap.buckets[0]!.mid).toBe(107.5);
    expect(new Set(heatmap.cells.map((c) => c[0]))).toEqual(new Set([0, 1]));
  });

  it("takes the colour cap from the non-empty cells only, so the zeros of the spread do not pull it down", () => {
    const heatmap = buildDepthHeatmap([frame(at(0))], { rowPoints: 2 });
    // Non-empty cells total 90, 50, 10, 20, 60 -> 5 values; 95th percentile by nearest rank is the largest.
    expect(heatmap.scale).toEqual({ capQty: 90, capPercentile: HEATMAP_CAP_PERCENTILE, maxQty: 90, cellsWithLiquidity: 5 });
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 10)).toBe(1);
  });

  it("is null for no values and does not reorder its input", () => {
    expect(percentile([], 95)).toBeNull();
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it("lets one huge value sit above the cap instead of setting it", () => {
    const values = [...Array.from({ length: 99 }, () => 100), 1_000_000];
    expect(percentile(values, 95)).toBe(100);
  });
});
