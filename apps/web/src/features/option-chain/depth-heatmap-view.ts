/**
 * Types and pure drawing rules for the liquidity heatmap. No React.
 *
 * The API (`/api/v1/depth/heatmap`) decides what a cell is: it emits a price bin only for frames whose stored levels
 * describe all of it, so a covered bin with nothing resting is a real zero and an uncovered bin is simply absent. This
 * module only turns cells into coordinates and colours, and keeps four promises:
 *
 * - **Unknown is not empty.** A bin the API did not emit is not drawn. A bin it emitted with nothing in it is drawn
 *   as a faint cell, so "seen and empty" (the spread, a gap between levels) differs from "not seen".
 * - **Time is real time.** Columns sit at their real position on the session's clock, so a hole in the capture is a
 *   hole in the picture, not columns squeezed together.
 * - **Colour is capped, and says where.** Intensity is linear up to the API's cap (a percentile of the day's cells),
 *   so one huge order cannot wash out the rest, and anything above the cap is called out as saturated.
 * - **Colour is not the only carrier.** The side (bid or ask) and the quantity are in the hover text and the legend,
 *   so no reader has to tell two hues apart to read a cell.
 */

export interface HeatmapBucket {
  t: string;
  frames: number;
  usableFrames: number;
  mid: number | null;
}

/** `[bucketIndex, row, bidQty, askQty, framesCovering]` as sent by the API. */
export type HeatmapCell = [number, number, number, number, number];

export interface DepthHeatmapAvailable {
  available: true;
  underlying: string;
  contract: { providerSymbol: string; expiryDate: string | null };
  sessionDate: string;
  sessionTimezone: string;
  window: { from: string; to: string };
  inProgress: boolean;
  bucketSeconds: number;
  rowPoints: number;
  buckets: HeatmapBucket[];
  cells: HeatmapCell[];
  scale: { capQty: number | null; capPercentile: number; maxQty: number | null; cellsWithLiquidity: number };
  rowRange: { low: number; high: number } | null;
  counts: { framesInSession: number; framesUsed: number; framesWithoutLevelMetrics: number };
  gaps: Array<{ from: string; to: string; seconds: number }>;
  captureSessions: Array<{ captureSessionId: string; frames: number; firstAt: string; lastAt: string }>;
  concurrentWriters: Array<{ a: string; b: string; overlapFrom: string; overlapTo: string; overlapSeconds: number }>;
  availableSessions: Array<{
    sessionDate: string; providerSymbol: string; firstAt: string; lastAt: string; framesCapped: number; sparse: boolean;
  }>;
  definitions: Record<string, string>;
  source: string;
}

export interface DepthHeatmapUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  reason: string;
  contractsTried?: string[];
  availableSessions?: DepthHeatmapAvailable["availableSessions"];
}

export type DepthHeatmapPayload = DepthHeatmapAvailable | DepthHeatmapUnavailable;

export const HEATMAP_COLUMN_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 30, label: "30 s" },
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
];
export const HEATMAP_ROW_CHOICES: ReadonlyArray<{ points: number; label: string }> = [
  { points: 1, label: "1 pt" },
  { points: 2, label: "2 pts" },
  { points: 5, label: "5 pts" },
];
export const DEFAULT_HEATMAP_COLUMN_SECONDS = 60;
export const DEFAULT_HEATMAP_ROW_POINTS = 2;

export function heatmapQuery(input: { underlying: string; sessionDate: string; bucketSeconds: number; rowPoints: number }): string {
  const params = new URLSearchParams({
    underlying: input.underlying,
    bucketSeconds: String(input.bucketSeconds),
    rowPoints: String(input.rowPoints),
  });
  if (input.sessionDate) params.set("date", input.sessionDate);
  return params.toString();
}

export type CellSide = "bid" | "ask" | "empty";

/** Which side a cell's resting quantity is mostly on. A cell with neither is seen-and-empty, not unknown. */
export function cellSide(bidQty: number, askQty: number): CellSide {
  if (bidQty <= 0 && askQty <= 0) return "empty";
  return bidQty >= askQty ? "bid" : "ask";
}

/**
 * 0..1 intensity: linear in the cell's total quantity up to the cap, then saturated. Without a cap (no cell holds
 * anything) every cell is 0.
 */
export function cellIntensity(totalQty: number, capQty: number | null): number {
  if (capQty === null || !(capQty > 0) || !(totalQty > 0)) return 0;
  return Math.min(1, totalQty / capQty);
}

const BID_RGB = "52,211,153";
const ASK_RGB = "244,114,182";
const EMPTY_FILL = "rgba(148,163,184,0.07)";

/** Fill colour: a faint grey for seen-and-empty, otherwise the side's hue with opacity from the intensity. */
export function cellFill(side: CellSide, intensity: number): string {
  if (side === "empty") return EMPTY_FILL;
  const alpha = 0.14 + 0.86 * Math.min(1, Math.max(0, intensity));
  return `rgba(${side === "bid" ? BID_RGB : ASK_RGB},${alpha.toFixed(3)})`;
}

export interface DrawnCell {
  /** Left edge and width, as fractions of the session window (0..1). */
  x: number;
  width: number;
  /** Top edge and height, as fractions of the price range (0 at the highest bin). */
  y: number;
  height: number;
  bucketIndex: number;
  row: number;
  bidQty: number;
  askQty: number;
  framesCovering: number;
  side: CellSide;
  intensity: number;
  saturated: boolean;
}

export interface HeatmapGeometry {
  cells: DrawnCell[];
  /** Number of price rows from the highest to the lowest bin, inclusive. */
  rowCount: number;
  /** Where each bucket's mid sits: x as a fraction of the window, y as a fraction of the price range, or null. */
  midPoints: Array<{ x: number; y: number | null; bucketIndex: number }>;
  gapSpans: Array<{ x: number; width: number; seconds: number }>;
  /** Fraction of the window one bucket occupies. */
  columnWidth: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Pure geometry of the grid in session-window fractions; the panel scales it to pixels. Empty when nothing is drawn. */
export function buildHeatmapGeometry(payload: DepthHeatmapAvailable): HeatmapGeometry {
  const from = Date.parse(payload.window.from);
  const to = Date.parse(payload.window.to);
  const span = to - from;
  const range = payload.rowRange;
  if (!(span > 0) || range === null) {
    return { cells: [], rowCount: 0, midPoints: [], gapSpans: [], columnWidth: 0 };
  }
  const rowCount = range.high - range.low + 1;
  const columnWidth = (payload.bucketSeconds * 1000) / span;
  const starts = payload.buckets.map((bucket) => Date.parse(bucket.t));
  const cap = payload.scale.capQty;

  const cells: DrawnCell[] = payload.cells.map(([bucketIndex, row, bidQty, askQty, framesCovering]) => {
    const total = bidQty + askQty;
    return {
      x: clamp01((starts[bucketIndex]! - from) / span),
      width: columnWidth,
      y: (range.high - row) / rowCount,
      height: 1 / rowCount,
      bucketIndex,
      row,
      bidQty,
      askQty,
      framesCovering,
      side: cellSide(bidQty, askQty),
      intensity: cellIntensity(total, cap),
      saturated: cap !== null && total > cap,
    };
  });

  // The mid is plotted at the middle of its column, on the middle of its price row.
  const midPoints = payload.buckets.map((bucket, bucketIndex) => ({
    x: clamp01((starts[bucketIndex]! + (payload.bucketSeconds * 1000) / 2 - from) / span),
    y: bucket.mid === null ? null : (range.high + 1 - bucket.mid / payload.rowPoints) / rowCount,
    bucketIndex,
  }));

  const gapSpans = payload.gaps
    .map((gap) => ({ start: Date.parse(gap.from), end: Date.parse(gap.to), seconds: gap.seconds }))
    .filter((gap) => Number.isFinite(gap.start) && Number.isFinite(gap.end) && gap.end > gap.start)
    .map((gap) => ({ x: clamp01((gap.start - from) / span), width: clamp01((gap.end - gap.start) / span), seconds: gap.seconds }));

  return { cells, rowCount, midPoints, gapSpans, columnWidth };
}

/**
 * The instant whose book playback shows for a column: the last millisecond of the bucket, so the ladder is the book
 * as it stood when that column closed. Never later than `nowMs`: the API refuses an instant in the future, and an
 * open session's last column has not closed yet.
 */
export function playbackInstant(bucket: HeatmapBucket, bucketSeconds: number, nowMs: number): string {
  const end = Date.parse(bucket.t) + bucketSeconds * 1000 - 1;
  return new Date(Math.min(end, nowMs)).toISOString();
}

/** The column under a horizontal position (a fraction of the window), or null where no column was captured. */
export function bucketAtFraction(payload: Pick<DepthHeatmapAvailable, "window" | "buckets" | "bucketSeconds">, fraction: number): number | null {
  const from = Date.parse(payload.window.from);
  const at = from + fraction * (Date.parse(payload.window.to) - from);
  const bucketMs = payload.bucketSeconds * 1000;
  const index = payload.buckets.findIndex((bucket) => {
    const start = Date.parse(bucket.t);
    return at >= start && at < start + bucketMs;
  });
  return index === -1 ? null : index;
}

/** The price bin under a vertical position (a fraction of the range, 0 at the top): its row, or null outside the range. */
export function rowAtFraction(rowRange: { low: number; high: number } | null, fraction: number): number | null {
  if (rowRange === null || fraction < 0 || fraction >= 1) return null;
  const rowCount = rowRange.high - rowRange.low + 1;
  return rowRange.high - Math.floor(fraction * rowCount);
}

/** Wording for what is under the pointer: the bin, and whether it holds something, nothing, or was not seen. */
export function describeCell(
  payload: DepthHeatmapAvailable,
  cellLookup: ReadonlyMap<string, HeatmapCell>,
  bucketIndex: number,
  row: number,
): string {
  const low = row * payload.rowPoints;
  const bin = `${low}–${low + payload.rowPoints}`;
  const cell = cellLookup.get(`${bucketIndex}:${row}`);
  if (!cell) return `${bin}: not seen. The stored levels did not cover this price then, so it may hold anything.`;
  const [, , bid, ask, n] = cell;
  if (bid <= 0 && ask <= 0) return `${bin}: seen, nothing resting (${n} frame${n === 1 ? "" : "s"}).`;
  const parts = [bid > 0 ? `${Math.round(bid).toLocaleString("en-IN")} on the bid` : null, ask > 0 ? `${Math.round(ask).toLocaleString("en-IN")} on the ask` : null];
  return `${bin}: ${parts.filter(Boolean).join(" and ")} (units, resting; mean of ${n} frame${n === 1 ? "" : "s"}).`;
}

/** Key for the cell lookup the panel builds once per payload. */
export function cellKey(bucketIndex: number, row: number): string {
  return `${bucketIndex}:${row}`;
}

/** The sentence under the legend: what the cap is, so a bright cell is read against the right yardstick. */
export function scaleSentence(scale: DepthHeatmapAvailable["scale"]): string {
  if (scale.capQty === null) return "No cell holds any resting quantity, so there is no colour scale.";
  return `Colour is linear up to ${Math.round(scale.capQty).toLocaleString("en-IN")} units in a cell `
    + `(the ${scale.capPercentile}th percentile of the day's ${scale.cellsWithLiquidity.toLocaleString("en-IN")} non-empty cells; `
    + `the largest is ${Math.round(scale.maxQty ?? 0).toLocaleString("en-IN")}) and saturates above it.`;
}

export function heatmapSessionLabel(session: DepthHeatmapAvailable["availableSessions"][number]): string {
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  return `${session.sessionDate} · ${clock(session.firstAt)}–${clock(session.lastAt)} IST${session.sparse ? " · sparse (under 1,000 frames)" : ""}`;
}
