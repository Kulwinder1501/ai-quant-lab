import { describe, expect, it } from "vitest";
import {
  bucketAtFraction,
  buildHeatmapGeometry,
  cellFill,
  cellIntensity,
  cellKey,
  cellSide,
  describeCell,
  heatmapQuery,
  heatmapSessionLabel,
  playbackInstant,
  rowAtFraction,
  scaleSentence,
  type DepthHeatmapAvailable,
  type HeatmapCell,
} from "./depth-heatmap-view";

/** Synthetic payloads, hand-built for the rules below (not recorded from the API). Window 10:00-11:00 IST. */
const FROM = Date.parse("2026-10-22T04:30:00.000Z");
const iso = (seconds: number) => new Date(FROM + seconds * 1000).toISOString();

function payload(overrides: Partial<DepthHeatmapAvailable> = {}): DepthHeatmapAvailable {
  return {
    available: true,
    underlying: "BANKNIFTY",
    contract: { providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27" },
    sessionDate: "2026-10-22",
    sessionTimezone: "Asia/Kolkata",
    window: { from: iso(0), to: iso(3600) },
    inProgress: false,
    bucketSeconds: 60,
    rowPoints: 2,
    buckets: [
      { t: iso(0), frames: 100, usableFrames: 100, mid: 54_005 },
      { t: iso(60), frames: 100, usableFrames: 100, mid: null },
      { t: iso(600), frames: 100, usableFrames: 100, mid: 54_011 },
    ],
    // rows 27000..27004 are 54000-54010; price range spans five rows.
    cells: [
      [0, 27_004, 400, 0, 100],
      [0, 27_002, 0, 0, 100],
      [0, 27_000, 0, 250, 40],
      [2, 27_003, 100, 300, 90],
    ],
    scale: { capQty: 200, capPercentile: 95, maxQty: 400, cellsWithLiquidity: 3 },
    rowRange: { low: 27_000, high: 27_004 },
    counts: { framesInSession: 300, framesUsed: 300, framesWithoutLevelMetrics: 0 },
    storedLevels: { min: 10, max: 10 },
    gaps: [{ from: iso(120), to: iso(600), seconds: 480 }],
    captureSessions: [],
    concurrentWriters: [],
    availableSessions: [],
    definitions: {},
    source: "depth_frames",
    ...overrides,
  };
}

describe("cellSide and cellIntensity", () => {
  it("calls a cell with nothing in it empty, and otherwise names the side with more quantity", () => {
    expect(cellSide(0, 0)).toBe("empty");
    expect(cellSide(100, 20)).toBe("bid");
    expect(cellSide(20, 100)).toBe("ask");
    expect(cellSide(50, 50)).toBe("bid"); // a tie reads as bid: stated, not hidden
  });

  it("is linear up to the cap and saturated above it", () => {
    expect(cellIntensity(100, 200)).toBe(0.5);
    expect(cellIntensity(200, 200)).toBe(1);
    expect(cellIntensity(4_000, 200)).toBe(1);
  });

  it("is zero without a usable cap or without quantity, never NaN", () => {
    expect(cellIntensity(100, null)).toBe(0);
    expect(cellIntensity(100, 0)).toBe(0);
    expect(cellIntensity(0, 200)).toBe(0);
    expect(cellIntensity(-5, 200)).toBe(0);
  });
});

describe("cellFill", () => {
  it("draws seen-and-empty as a faint grey, distinct from any filled cell", () => {
    expect(cellFill("empty", 0)).toBe("rgba(148,163,184,0.07)");
    expect(cellFill("bid", 0)).not.toBe(cellFill("empty", 0));
  });

  it("uses a different hue per side and a stronger opacity for a stronger cell", () => {
    expect(cellFill("bid", 1)).toBe("rgba(52,211,153,1.000)");
    expect(cellFill("ask", 1)).toBe("rgba(244,114,182,1.000)");
    expect(cellFill("bid", 0.5)).toBe("rgba(52,211,153,0.570)");
  });

  it("keeps even the faintest filled cell visible, and clamps an out-of-range intensity", () => {
    expect(cellFill("bid", 0)).toBe("rgba(52,211,153,0.140)");
    expect(cellFill("bid", 7)).toBe("rgba(52,211,153,1.000)");
    expect(cellFill("bid", -1)).toBe("rgba(52,211,153,0.140)");
  });
});

describe("buildHeatmapGeometry", () => {
  it("places a column at its real time on the session clock and sizes it by the bucket", () => {
    const geometry = buildHeatmapGeometry(payload());
    expect(geometry.columnWidth).toBeCloseTo(60 / 3600, 10);
    const first = geometry.cells.find((c) => c.bucketIndex === 0)!;
    const third = geometry.cells.find((c) => c.bucketIndex === 2)!;
    expect(first.x).toBe(0);
    expect(third.x).toBeCloseTo(600 / 3600, 10); // a ten-minute hole leaves a ten-minute space, not adjacent columns
  });

  it("puts the highest price bin on top, one row tall", () => {
    const geometry = buildHeatmapGeometry(payload());
    expect(geometry.rowCount).toBe(5);
    const top = geometry.cells.find((c) => c.row === 27_004)!;
    const bottom = geometry.cells.find((c) => c.row === 27_000)!;
    expect(top.y).toBe(0);
    expect(bottom.y).toBeCloseTo(4 / 5, 10);
    expect(top.height).toBeCloseTo(1 / 5, 10);
  });

  it("derives side, intensity and saturation from the API's cap", () => {
    const cells = buildHeatmapGeometry(payload()).cells;
    const huge = cells.find((c) => c.row === 27_004)!;
    expect(huge).toMatchObject({ side: "bid", intensity: 1, saturated: true });
    const empty = cells.find((c) => c.row === 27_002)!;
    expect(empty).toMatchObject({ side: "empty", intensity: 0, saturated: false });
    const mixed = cells.find((c) => c.row === 27_003)!;
    expect(mixed).toMatchObject({ side: "ask", intensity: 1, saturated: true }); // 400 total against a cap of 200
    expect(cells.find((c) => c.row === 27_000)).toMatchObject({ side: "ask", intensity: 1 });
  });

  it("does not call a cell saturated when it is exactly at the cap", () => {
    const geometry = buildHeatmapGeometry(payload({ cells: [[0, 27_000, 200, 0, 5]], scale: { capQty: 200, capPercentile: 95, maxQty: 200, cellsWithLiquidity: 1 }, rowRange: { low: 27_000, high: 27_000 } }));
    expect(geometry.cells[0]).toMatchObject({ intensity: 1, saturated: false });
  });

  it("plots the mid in the middle of its column and null where there is none", () => {
    const { midPoints } = buildHeatmapGeometry(payload());
    expect(midPoints[0]!.x).toBeCloseTo(30 / 3600, 10);
    // 54,005 / 2 = 27,002.5, in the middle of row 27,002: y = (27,004 + 1 - 27,002.5) / 5 = 0.5
    expect(midPoints[0]!.y).toBeCloseTo(0.5, 10);
    expect(midPoints[1]!.y).toBeNull();
  });

  it("turns each hole in the capture into a span at its real position", () => {
    const { gapSpans } = buildHeatmapGeometry(payload());
    expect(gapSpans).toHaveLength(1);
    expect(gapSpans[0]!.x).toBeCloseTo(120 / 3600, 10);
    expect(gapSpans[0]!.width).toBeCloseTo(480 / 3600, 10);
  });

  it("ignores a gap that is not a forward span", () => {
    expect(buildHeatmapGeometry(payload({ gaps: [{ from: iso(10), to: iso(10), seconds: 0 }, { from: "nope", to: iso(5), seconds: 1 }] })).gapSpans).toEqual([]);
  });

  it("draws nothing for an empty grid instead of dividing by zero", () => {
    const geometry = buildHeatmapGeometry(payload({ cells: [], buckets: [], rowRange: null }));
    expect(geometry).toEqual({ cells: [], rowCount: 0, midPoints: [], gapSpans: [], columnWidth: 0 });
  });
});

describe("hit testing", () => {
  it("finds the column under a position, and none inside a hole", () => {
    const p = payload();
    expect(bucketAtFraction(p, 30 / 3600)).toBe(0);
    expect(bucketAtFraction(p, 90 / 3600)).toBe(1);
    expect(bucketAtFraction(p, 300 / 3600)).toBeNull();
    expect(bucketAtFraction(p, 630 / 3600)).toBe(2);
  });

  it("treats a column as half-open, so a boundary belongs to the next column", () => {
    expect(bucketAtFraction(payload(), 60 / 3600)).toBe(1);
  });

  it("finds the price row under a position, highest at the top, and none outside the range", () => {
    const range = { low: 27_000, high: 27_004 };
    expect(rowAtFraction(range, 0)).toBe(27_004);
    expect(rowAtFraction(range, 0.99)).toBe(27_000);
    expect(rowAtFraction(range, 0.5)).toBe(27_002);
    expect(rowAtFraction(range, 1)).toBeNull();
    expect(rowAtFraction(range, -0.1)).toBeNull();
    expect(rowAtFraction(null, 0.5)).toBeNull();
  });
});

describe("describeCell", () => {
  const p = payload();
  const lookup = new Map<string, HeatmapCell>(p.cells.map((c) => [cellKey(c[0], c[1]), c]));

  it("says a bin that was not emitted was not seen, and may hold anything", () => {
    const text = describeCell(p, lookup, 0, 27_001);
    expect(text).toContain("54002–54004: not seen");
    expect(text).toContain("may hold anything");
  });

  it("says a bin with nothing resting was seen and empty, with how many frames saw it", () => {
    expect(describeCell(p, lookup, 0, 27_002)).toBe("54004–54006: seen, nothing resting (100 frames).");
  });

  it("gives quantities by side for a bin that holds something", () => {
    expect(describeCell(p, lookup, 0, 27_004)).toBe("54008–54010: 400 on the bid (units, resting; mean of 100 frames).");
    expect(describeCell(p, lookup, 2, 27_003)).toBe("54006–54008: 100 on the bid and 300 on the ask (units, resting; mean of 90 frames).");
  });

  it("uses the singular for a single frame", () => {
    const one = new Map<string, HeatmapCell>([[cellKey(0, 27_000), [0, 27_000, 0, 0, 1]]]);
    expect(describeCell(p, one, 0, 27_000)).toContain("(1 frame)");
  });
});

describe("playbackInstant", () => {
  const bucket = { t: iso(60), frames: 1, usableFrames: 1, mid: null };

  it("is the last millisecond of the column, so the ladder is the book as the column closed", () => {
    expect(playbackInstant(bucket, 60, FROM + 10 * 3_600_000)).toBe(new Date(FROM + 120_000 - 1).toISOString());
  });

  it("never reaches past the present: an open session's last column has not closed", () => {
    const now = FROM + 90_000;
    expect(playbackInstant(bucket, 60, now)).toBe(new Date(now).toISOString());
  });
});

describe("query and wording helpers", () => {
  it("omits an empty session and always sends the column and row sizes", () => {
    expect(heatmapQuery({ underlying: "BANKNIFTY", sessionDate: "", bucketSeconds: 60, rowPoints: 2 }))
      .toBe("underlying=BANKNIFTY&bucketSeconds=60&rowPoints=2");
    expect(heatmapQuery({ underlying: "NIFTY50", sessionDate: "2026-10-22", bucketSeconds: 300, rowPoints: 5 }))
      .toBe("underlying=NIFTY50&bucketSeconds=300&rowPoints=5&date=2026-10-22");
  });

  it("states the colour cap, its percentile and the day's maximum, so brightness is read against the right yardstick", () => {
    expect(scaleSentence({ capQty: 428.57, capPercentile: 95, maxQty: 4239.17, cellsWithLiquidity: 13_381 }))
      .toBe("Colour is linear up to 429 units in a cell (the 95th percentile of the day's 13,381 non-empty cells; the largest is 4,239) and saturates above it.");
    expect(scaleSentence({ capQty: null, capPercentile: 95, maxQty: null, cellsWithLiquidity: 0 })).toContain("no colour scale");
  });

  it("labels a session with its IST span and flags a sparse one", () => {
    const session = { sessionDate: "2026-10-20", providerSymbol: "x", firstAt: "2026-10-20T05:43:43.000Z", lastAt: "2026-10-20T09:55:56.000Z", framesCapped: 4, sparse: true };
    expect(heatmapSessionLabel(session)).toBe("2026-10-20 · 11:13–15:25 IST · sparse (under 1,000 frames)");
  });
});
