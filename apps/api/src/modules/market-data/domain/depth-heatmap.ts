/**
 * One session of stored order-book frames as a price-by-time grid of resting quantity. Pure.
 *
 * Resting quantity is not traded quantity, and a bright cell is displayed liquidity at that price, not a level price
 * must respect: orders are placed and pulled, and a large one can vanish before it trades. This is an observation of
 * the book, not a signal.
 *
 * The one thing a heatmap of a truncated book must get right is the difference between *empty* and *not seen*:
 *
 * - Only the best N levels a side are stored (10, then 50 from the day the collector was raised), and ten reach a few points
 *   (median 5.4, see `depth-ladder.ts`). A
 *   price inside the span from the deepest stored bid to the deepest stored ask is fully described: it either holds
 *   a stored level or holds nothing (the spread, or a gap between levels). A price outside that span is **unknown**:
 *   it may hold a great deal.
 * - A cell is therefore emitted only for a price bin that a frame covers *entirely*, and a bin with nothing resting
 *   is a real zero. A bin no frame covered is absent, never a zero. A cell's value is the mean over the frames that
 *   covered it, so a frame that could not see the bin does not dilute it.
 * - Frames whose book fails the ladder's rules (crossed, out of order, pre-2026-09-07 capture) contribute nothing.
 *
 * Quantities are underlying units (contracts x lot size), not lots. Price bins are `rowPoints` index points tall and
 * the bin of a price is `floor(price / rowPoints)`.
 */
import { buildDepthLadder, isDepthSession, type StoredDepthFrame } from "./depth-ladder.js";

export const HEATMAP_BUCKET_SECONDS = [30, 60, 300] as const;
export type HeatmapBucketSeconds = (typeof HEATMAP_BUCKET_SECONDS)[number];
export const DEFAULT_HEATMAP_BUCKET_SECONDS: HeatmapBucketSeconds = 60;

export const HEATMAP_ROW_POINTS = [1, 2, 5] as const;
export type HeatmapRowPoints = (typeof HEATMAP_ROW_POINTS)[number];
export const DEFAULT_HEATMAP_ROW_POINTS: HeatmapRowPoints = 2;

/** The colour scale tops out at this percentile of the day's non-empty cells, so one huge order does not wash out the rest. */
export const HEATMAP_CAP_PERCENTILE = 95;

/** A price a hair under a bin edge is not in the bin below it: tolerance for float noise in 0.05-point prices. */
const EDGE_EPSILON = 1e-9;

export interface HeatmapBucket {
  /** Start of the bucket, ISO-8601 UTC. */
  t: string;
  /** In-session frames received in the bucket. */
  frames: number;
  /** Frames that contributed to the grid. */
  usableFrames: number;
  /** Median of (best bid + best ask) / 2 over the usable frames; null when there are none. */
  mid: number | null;
}

/** `[bucketIndex, row, bidQty, askQty, framesCovering]`. `bucketIndex` indexes `buckets`; the bin's low price is `row * rowPoints`. */
export type HeatmapCell = [number, number, number, number, number];

export interface DepthHeatmap {
  bucketSeconds: number;
  rowPoints: number;
  buckets: HeatmapBucket[];
  cellFields: readonly ["bucketIndex", "row", "bidQty", "askQty", "framesCovering"];
  cells: HeatmapCell[];
  scale: {
    /** The quantity (bid + ask) at which the colour scale saturates; null when no cell holds anything. */
    capQty: number | null;
    capPercentile: number;
    maxQty: number | null;
    /** Cells holding some quantity, the population the percentile is taken over. */
    cellsWithLiquidity: number;
  };
  /** Lowest and highest bin rows with a cell, for sizing the price axis. Null for an empty grid. */
  rowRange: { low: number; high: number } | null;
  counts: {
    framesInSession: number;
    framesUsed: number;
    framesWithoutLevelMetrics: number;
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Nearest-rank percentile of a list, for a colour cap. Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export function buildDepthHeatmap(
  frames: readonly StoredDepthFrame[],
  options: { bucketSeconds?: HeatmapBucketSeconds; rowPoints?: HeatmapRowPoints } = {},
): DepthHeatmap {
  const bucketSeconds = options.bucketSeconds ?? DEFAULT_HEATMAP_BUCKET_SECONDS;
  const rowPoints = options.rowPoints ?? DEFAULT_HEATMAP_ROW_POINTS;
  const bucketMs = bucketSeconds * 1000;

  const inSession = [...frames]
    .sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime())
    .filter((frame) => isDepthSession(frame.receivedAt));

  interface BucketAccumulator { start: number; frames: number; mids: number[]; cells: Map<number, { bid: number; ask: number; n: number }> }
  const buckets = new Map<number, BucketAccumulator>();
  let framesUsed = 0;
  let framesWithoutLevelMetrics = 0;

  for (const frame of inSession) {
    const start = Math.floor(frame.receivedAt.getTime() / bucketMs) * bucketMs;
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = { start, frames: 0, mids: [], cells: new Map() };
      buckets.set(start, bucket);
    }
    bucket.frames += 1;

    const ladder = buildDepthLadder(frame, { now: frame.receivedAt, historical: true });
    // The ladder withholds the touch exactly when the book cannot be trusted level by level.
    if (ladder.bestBid === null || ladder.bestAsk === null || ladder.mid === null
      || ladder.bids.length === 0 || ladder.asks.length === 0) {
      framesWithoutLevelMetrics += 1;
      continue;
    }
    framesUsed += 1;
    bucket.mids.push(ladder.mid);

    // The span the stored levels describe completely: deepest stored bid up to deepest stored ask.
    const lowKnown = ladder.bids[ladder.bids.length - 1]!.price;
    const highKnown = ladder.asks[ladder.asks.length - 1]!.price;
    // A bin is covered only if all of [lo, hi) lies inside that span.
    const firstRow = Math.ceil((lowKnown - EDGE_EPSILON) / rowPoints);
    const lastRow = Math.floor((highKnown + EDGE_EPSILON) / rowPoints) - 1;
    if (lastRow < firstRow) continue;

    const bidByRow = new Map<number, number>();
    for (const level of ladder.bids) {
      const row = Math.floor((level.price + EDGE_EPSILON) / rowPoints);
      if (row >= firstRow && row <= lastRow) bidByRow.set(row, (bidByRow.get(row) ?? 0) + level.qty);
    }
    const askByRow = new Map<number, number>();
    for (const level of ladder.asks) {
      const row = Math.floor((level.price + EDGE_EPSILON) / rowPoints);
      if (row >= firstRow && row <= lastRow) askByRow.set(row, (askByRow.get(row) ?? 0) + level.qty);
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const cell = bucket.cells.get(row);
      const bid = bidByRow.get(row) ?? 0;
      const ask = askByRow.get(row) ?? 0;
      if (cell) { cell.bid += bid; cell.ask += ask; cell.n += 1; } else bucket.cells.set(row, { bid, ask, n: 1 });
    }
  }

  const ordered = [...buckets.values()].sort((a, b) => a.start - b.start);
  const cells: HeatmapCell[] = [];
  const outBuckets: HeatmapBucket[] = ordered.map((bucket, index) => {
    for (const [row, cell] of [...bucket.cells.entries()].sort(([a], [b]) => a - b)) {
      cells.push([index, row, round2(cell.bid / cell.n), round2(cell.ask / cell.n), cell.n]);
    }
    return {
      t: new Date(bucket.start).toISOString(),
      frames: bucket.frames,
      usableFrames: bucket.mids.length,
      mid: median(bucket.mids) === null ? null : round2(median(bucket.mids)!),
    };
  });

  const totals = cells.map((cell) => cell[2] + cell[3]).filter((total) => total > 0);
  let low = Infinity;
  let high = -Infinity;
  for (const cell of cells) { low = Math.min(low, cell[1]); high = Math.max(high, cell[1]); }

  return {
    bucketSeconds,
    rowPoints,
    buckets: outBuckets,
    cellFields: ["bucketIndex", "row", "bidQty", "askQty", "framesCovering"],
    cells,
    scale: {
      capQty: percentile(totals, HEATMAP_CAP_PERCENTILE),
      capPercentile: HEATMAP_CAP_PERCENTILE,
      maxQty: totals.length > 0 ? Math.max(...totals) : null,
      cellsWithLiquidity: totals.length,
    },
    rowRange: cells.length > 0 ? { low, high } : null,
    counts: { framesInSession: inSession.length, framesUsed, framesWithoutLevelMetrics },
  };
}

export const HEATMAP_DEFINITIONS = {
  cell: "Resting quantity at a price bin (rowPoints index points tall), averaged over the frames in the time bucket that saw the whole bin. Underlying units, not lots; resting, not traded.",
  empty: "A bin inside the span the stored levels describe (deepest stored bid to deepest stored ask) that holds nothing is a real zero and is drawn as an empty cell. A bin outside it is unknown and is not drawn at all.",
  scale: "Colour saturates at the 95th percentile of the day's non-empty cells (bid + ask), so a single very large order does not wash out the rest. Intensity is linear below that cap.",
  coverage: "Only the best N levels a side are stored (N is in the header: 10 before the collector was raised to 50, 50 after), so the heatmap shows the part of the book those levels reach. A price beyond them is not seen.",
} as const;
