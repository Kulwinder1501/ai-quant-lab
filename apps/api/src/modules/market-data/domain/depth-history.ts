/**
 * One session of stored order-book frames, reduced to a time series of spread and imbalance. Pure.
 *
 * Every frame goes through `buildDepthLadder`, so the history obeys the same rules as the single-frame ladder:
 * a crossed or non-monotone book, or a frame from the pre-2026-09-07 capture regime, contributes nothing to a
 * level-based figure, and a whole-book total that is not positive is a feed dropout, not a measurement. The
 * history never relaxes a rule the ladder enforces.
 *
 * What a bucket is, and is not:
 *
 * - **Observed, then summarised.** A bucket summarises the frames *received* in `[t, t + bucketSeconds)` by our
 *   own clock. The feed delivers about two frames a second and not at fixed intervals, so every frame counts
 *   once: a bucket's mean is a mean over frames, not over time. Each bucket says how many frames it holds.
 * - **A bucket with no usable frame has no value.** Spread and imbalance are null there, never zero.
 * - **A gap is a gap.** Two consecutive in-session frames more than `DEPTH_GAP_SECONDS` apart are reported as a
 *   gap, and a chart cuts its lines there. Nothing is interpolated.
 * - **Resting quantity, not trades.** The imbalance describes displayed liquidity; it is not order flow and not a
 *   forecast.
 */
import {
  findOverlappingSessions,
  summariseCaptureSessions,
} from "./capture-session-window.js";
import {
  buildDepthLadder,
  isDepthSession,
  type StoredDepthFrame,
} from "./depth-ladder.js";

export const DEPTH_HISTORY_BUCKET_SECONDS = [10, 30, 60, 300] as const;
export type DepthHistoryBucketSeconds = (typeof DEPTH_HISTORY_BUCKET_SECONDS)[number];
export const DEFAULT_DEPTH_HISTORY_BUCKET_SECONDS: DepthHistoryBucketSeconds = 60;

/**
 * Longer than this between two consecutive in-session frames is a hole in the capture. Normal spacing is ~0.5 s
 * and the ladder calls a book stale after 10 s; 30 s is past any ordinary stutter and short enough to show a
 * collector restart.
 */
export const DEPTH_GAP_SECONDS = 30;

/** A session day's frame count stops here: enough to tell a full day from a sparse one without scanning it. */
export const SESSION_DAY_COUNT_CAP = 1000;

/** Stands in for the capture session of a frame stored without one, so it is still counted and shown. */
export const UNATTRIBUTED_CAPTURE_SESSION = "unattributed";

export interface DepthHistoryBucket {
  /** Start of the bucket, ISO-8601 UTC. */
  t: string;
  frames: number;
  /** Frames whose level-indexed figures were usable (coherent book, keyed-by-level-number capture). */
  levelFrames: number;
  /** Median over `levelFrames`. */
  spreadMedianPoints: number | null;
  /** The widest spread seen in the bucket: a spike that a median would hide. */
  spreadMaxPoints: number | null;
  midMedian: number | null;
  /** Mean over the frames that have the figure. Top-of-book only: see `IMBALANCE_DEFINITIONS`. */
  imbalanceL1: number | null;
  imbalanceL5: number | null;
  /** Frames with a usable whole-book total on both sides. */
  wholeBookFrames: number;
  imbalanceWholeBook: number | null;
}

export interface DepthHistoryGap {
  from: string;
  to: string;
  seconds: number;
}

export interface CaptureSessionSpan {
  captureSessionId: string;
  frames: number;
  firstAt: string;
  lastAt: string;
}

export interface ConcurrentWriters {
  a: string;
  b: string;
  overlapFrom: string;
  overlapTo: string;
  overlapSeconds: number;
}

export interface DepthHistory {
  bucketSeconds: number;
  buckets: DepthHistoryBucket[];
  gaps: DepthHistoryGap[];
  captureSessions: CaptureSessionSpan[];
  /** Pairs of capture sessions that were writing the same contract at once. Empty when the stream is single. */
  concurrentWriters: ConcurrentWriters[];
  counts: {
    framesRead: number;
    framesInSession: number;
    framesOutsideSession: number;
    /** In-session frames whose level-indexed figures were withheld (incoherent book or old capture regime). */
    framesWithoutLevelMetrics: number;
    /** In-session frames with no usable whole-book total (dropout, or the pre-2026-09-17 collector defect). */
    framesWithoutWholeBook: number;
    framesFlaggedDuplicate: number;
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Four decimals: enough for a price-point difference or a ratio, and it removes float noise. */
function round4(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

/**
 * Capture sessions from the shared `capture-session-window` rules: a collector that restarts leaves a hole, but
 * two sessions whose first-to-last ranges intersect were writing the same contract at once, so the interleaved
 * stream is two streams and a count, a gap or a mean over it is not about one feed. Any intersection is reported
 * with its length rather than judged against a tolerance.
 */
function accountForCaptureSessions(frames: readonly StoredDepthFrame[]): {
  captureSessions: CaptureSessionSpan[];
  concurrentWriters: ConcurrentWriters[];
} {
  const summaries = summariseCaptureSessions(
    frames.map((frame) => ({
      captureSessionId: frame.captureSessionId ?? UNATTRIBUTED_CAPTURE_SESSION,
      receivedAt: frame.receivedAt,
    })),
  );
  return {
    captureSessions: summaries.map((summary) => ({
      captureSessionId: summary.captureSessionId,
      frames: summary.frames,
      firstAt: summary.firstAt.toISOString(),
      lastAt: summary.lastAt.toISOString(),
    })),
    concurrentWriters: findOverlappingSessions(summaries).map((pair) => ({
      a: pair.sessionA,
      b: pair.sessionB,
      overlapFrom: pair.overlapFrom.toISOString(),
      overlapTo: pair.overlapTo.toISOString(),
      overlapSeconds: (pair.overlapTo.getTime() - pair.overlapFrom.getTime()) / 1000,
    })),
  };
}

export function buildDepthHistory(
  frames: readonly StoredDepthFrame[],
  options: { bucketSeconds?: DepthHistoryBucketSeconds } = {},
): DepthHistory {
  const bucketSeconds = options.bucketSeconds ?? DEFAULT_DEPTH_HISTORY_BUCKET_SECONDS;
  const bucketMs = bucketSeconds * 1000;

  const ordered = [...frames].sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
  const inSession = ordered.filter((frame) => isDepthSession(frame.receivedAt));

  interface Accumulator {
    frames: number;
    levelFrames: number;
    spreads: number[];
    mids: number[];
    l1: number[];
    l5: number[];
    wholeBook: number[];
  }
  const accumulators = new Map<number, Accumulator>();
  let framesWithoutLevelMetrics = 0;
  let framesWithoutWholeBook = 0;
  let framesFlaggedDuplicate = 0;

  for (const frame of inSession) {
    // `now` only sets the live/stale status, which the history does not use; the frame is a past instant.
    const ladder = buildDepthLadder(frame, { now: frame.receivedAt, historical: true });
    const key = Math.floor(frame.receivedAt.getTime() / bucketMs) * bucketMs;
    let bucket = accumulators.get(key);
    if (!bucket) {
      bucket = { frames: 0, levelFrames: 0, spreads: [], mids: [], l1: [], l5: [], wholeBook: [] };
      accumulators.set(key, bucket);
    }
    bucket.frames += 1;
    if (frame.isDuplicate) framesFlaggedDuplicate += 1;

    if (ladder.spread !== null && ladder.mid !== null) {
      bucket.levelFrames += 1;
      bucket.spreads.push(ladder.spread.points);
      bucket.mids.push(ladder.mid);
      if (ladder.imbalance.topOfBook.l1 !== null) bucket.l1.push(ladder.imbalance.topOfBook.l1);
      if (ladder.imbalance.topOfBook.l5 !== null) bucket.l5.push(ladder.imbalance.topOfBook.l5);
    } else {
      framesWithoutLevelMetrics += 1;
    }
    if (ladder.imbalance.wholeBook !== null) bucket.wholeBook.push(ladder.imbalance.wholeBook);
    else framesWithoutWholeBook += 1;
  }

  const buckets: DepthHistoryBucket[] = [...accumulators.entries()]
    .sort(([x], [y]) => x - y)
    .map(([start, bucket]) => ({
      t: new Date(start).toISOString(),
      frames: bucket.frames,
      levelFrames: bucket.levelFrames,
      spreadMedianPoints: round4(median(bucket.spreads)),
      spreadMaxPoints: bucket.spreads.length > 0 ? round4(Math.max(...bucket.spreads)) : null,
      midMedian: round4(median(bucket.mids)),
      imbalanceL1: round4(mean(bucket.l1)),
      imbalanceL5: round4(mean(bucket.l5)),
      wholeBookFrames: bucket.wholeBook.length,
      imbalanceWholeBook: round4(mean(bucket.wholeBook)),
    }));

  const gaps: DepthHistoryGap[] = [];
  for (let i = 1; i < inSession.length; i += 1) {
    const before = inSession[i - 1]!.receivedAt.getTime();
    const after = inSession[i]!.receivedAt.getTime();
    const seconds = (after - before) / 1000;
    if (seconds > DEPTH_GAP_SECONDS) {
      gaps.push({ from: new Date(before).toISOString(), to: new Date(after).toISOString(), seconds });
    }
  }

  const { captureSessions, concurrentWriters } = accountForCaptureSessions(ordered);

  return {
    bucketSeconds,
    buckets,
    gaps,
    captureSessions,
    concurrentWriters,
    counts: {
      framesRead: ordered.length,
      framesInSession: inSession.length,
      framesOutsideSession: ordered.length - inSession.length,
      framesWithoutLevelMetrics,
      framesWithoutWholeBook,
      framesFlaggedDuplicate,
    },
  };
}

/** The IST trading day as a UTC window: 09:00 up to 15:30, the span `isDepthSession` accepts. Half-open. */
export function sessionWindowUtc(istDate: string): { from: Date; to: Date } {
  const [year, month, day] = istDate.split("-").map(Number);
  const midnightIstUtcMs = Date.UTC(year!, month! - 1, day!) - 330 * 60_000;
  return {
    from: new Date(midnightIstUtcMs + 9 * 60 * 60_000),
    to: new Date(midnightIstUtcMs + (15 * 60 + 30) * 60_000),
  };
}

export const DEPTH_HISTORY_DEFINITIONS = {
  bucket: "Frames received in [t, t + bucket) by our own clock. Means are over frames, not over time: the feed's frames are not evenly spaced.",
  spread: "Best ask minus best bid, in index points. The bucket's median, and its maximum so a brief widening is not averaged away.",
  imbalance: "(bid - ask) / (bid + ask), averaged over the frames in the bucket. Level 1 is the touch; level 5 is the first five stored levels of each side. Resting quantity, not traded volume.",
  wholeBook: "The same ratio from the feed's whole-book totals (all 50 levels). A frame with a zero total is a feed dropout and is left out.",
  gap: "More than 30 seconds between two consecutive in-session frames. Lines are cut there; nothing is interpolated.",
} as const;
