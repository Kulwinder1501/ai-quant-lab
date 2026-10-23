/**
 * Types and pure chart-series rules for the order-book history. No React.
 *
 * The API (`/api/v1/depth/history`) does the market-data work: it applies the ladder's rules to every stored frame,
 * buckets them, and reports the holes, the frames it had to leave out and any concurrent writers. This module only
 * turns that into plot rows and the notes that must sit beside the chart, and keeps four promises:
 *
 * - **A gap is a gap.** A hole in the capture gets a null-valued break row inside it, so a line is cut there rather
 *   than drawn across time with no frames. Nothing is interpolated.
 * - **Null is not zero.** A bucket with no usable frame plots as a break, never as a balanced book or a zero spread.
 * - **The frames that were left out are said so.** Withheld and dropout frames are counted in a note, in words, so
 *   a clean-looking line never hides how much of the session it stands on.
 * - **Resting quantity is not traded quantity.** Nothing here is flow or volume, and the imbalance over the stored
 *   levels is a top-of-book figure, labelled as one.
 */

export interface DepthHistoryBucket {
  /** Start of the bucket, ISO-8601 UTC. */
  t: string;
  frames: number;
  levelFrames: number;
  spreadMedianPoints: number | null;
  spreadMaxPoints: number | null;
  midMedian: number | null;
  imbalanceL1: number | null;
  imbalanceL5: number | null;
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

export interface DepthHistorySessionSummary {
  sessionDate: string;
  providerSymbol: string;
  firstAt: string;
  lastAt: string;
  /** Frame count, stopping at the API's cap: enough to tell a full day from a sparse one. */
  framesCapped: number;
  sparse: boolean;
}

export interface DepthHistoryAvailable {
  available: true;
  underlying: string;
  contract: { providerSymbol: string; expiryDate: string | null };
  sessionDate: string;
  sessionTimezone: string;
  window: { from: string; to: string };
  /** The session's own trading day is under way (09:00-15:30 IST): the book is still being written. */
  inProgress: boolean;
  bucketSeconds: number;
  buckets: DepthHistoryBucket[];
  gaps: DepthHistoryGap[];
  captureSessions: CaptureSessionSpan[];
  concurrentWriters: ConcurrentWriters[];
  counts: {
    framesRead: number;
    framesInSession: number;
    framesOutsideSession: number;
    framesWithoutLevelMetrics: number;
    framesWithoutWholeBook: number;
    framesFlaggedDuplicate: number;
  };
  availableSessions: DepthHistorySessionSummary[];
  definitions: Record<string, string>;
  source: string;
}

export interface DepthHistoryUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  reason: string;
  contractsTried?: string[];
  availableSessions?: DepthHistorySessionSummary[];
}

export type DepthHistoryPayload = DepthHistoryAvailable | DepthHistoryUnavailable;

export const BUCKET_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 10, label: "10 s" },
  { seconds: 30, label: "30 s" },
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
];

export const DEFAULT_BUCKET_SECONDS = 60;

/** The query string for `/depth/history`. An empty `sessionDate` is omitted so the server picks the latest. */
export function depthHistoryQuery(input: { underlying: string; sessionDate: string; bucketSeconds: number }): string {
  const params = new URLSearchParams({ underlying: input.underlying, bucketSeconds: String(input.bucketSeconds) });
  if (input.sessionDate) params.set("date", input.sessionDate);
  return params.toString();
}

export interface HistoryChartRow {
  /** Epoch ms of the middle of the bucket, where its summary is plotted. Break rows sit mid-gap. */
  t: number;
  bucketStart: number | null;
  bucketSeconds: number;
  frames: number;
  levelFrames: number;
  wholeBookFrames: number;
  /** True for the synthetic row that cuts lines inside a hole in the capture. */
  isGapBreak: boolean;
  gapSeconds: number | null;
  imbalanceL1: number | null;
  imbalanceL5: number | null;
  imbalanceWholeBook: number | null;
  spreadMedian: number | null;
  spreadMax: number | null;
  mid: number | null;
}

export interface DepthHistoryChartModel {
  rows: HistoryChartRow[];
  gapAreas: Array<{ x1: number; x2: number; seconds: number }>;
  /** Largest spread plotted, the top of the spread axis. Zero when nothing is plotted. */
  spreadMax: number;
  /** Why a chart has nothing to plot, per chart. Null when it has something. */
  emptyReason: { imbalance: string | null; wholeBook: string | null; spread: string | null; mid: string | null };
}

function breakRow(from: number, to: number, bucketSeconds: number): HistoryChartRow {
  return {
    t: Math.round((from + to) / 2),
    bucketStart: null,
    bucketSeconds,
    frames: 0,
    levelFrames: 0,
    wholeBookFrames: 0,
    isGapBreak: true,
    gapSeconds: (to - from) / 1000,
    imbalanceL1: null,
    imbalanceL5: null,
    imbalanceWholeBook: null,
    spreadMedian: null,
    spreadMax: null,
    mid: null,
  };
}

export function buildDepthHistoryChart(payload: DepthHistoryAvailable): DepthHistoryChartModel {
  const bucketMs = payload.bucketSeconds * 1000;
  const rows: HistoryChartRow[] = payload.buckets.map((bucket) => {
    const start = Date.parse(bucket.t);
    return {
      t: start + bucketMs / 2,
      bucketStart: start,
      bucketSeconds: payload.bucketSeconds,
      frames: bucket.frames,
      levelFrames: bucket.levelFrames,
      wholeBookFrames: bucket.wholeBookFrames,
      isGapBreak: false,
      gapSeconds: null,
      imbalanceL1: bucket.imbalanceL1,
      imbalanceL5: bucket.imbalanceL5,
      imbalanceWholeBook: bucket.imbalanceWholeBook,
      spreadMedian: bucket.spreadMedianPoints,
      spreadMax: bucket.spreadMaxPoints,
      mid: bucket.midMedian,
    };
  });

  const gapAreas: DepthHistoryChartModel["gapAreas"] = [];
  for (const gap of payload.gaps) {
    const from = Date.parse(gap.from);
    const to = Date.parse(gap.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    gapAreas.push({ x1: from, x2: to, seconds: gap.seconds });
    rows.push(breakRow(from, to, payload.bucketSeconds));
  }
  rows.sort((a, b) => a.t - b.t);

  let spreadMax = 0;
  for (const row of rows) if (row.spreadMax !== null) spreadMax = Math.max(spreadMax, row.spreadMax);

  const levelFrames = payload.buckets.reduce((sum, bucket) => sum + bucket.levelFrames, 0);
  const wholeBookFrames = payload.buckets.reduce((sum, bucket) => sum + bucket.wholeBookFrames, 0);
  const nothing = payload.buckets.length === 0 ? "No frame was stored inside the session window on this day." : null;
  const noLevels = nothing
    ?? (levelFrames === 0
      ? "No frame in this session has a book that can be used for level figures: it is crossed or out of order, or it was captured before 2026-09-07, when stored levels sat at arrival index and are not comparable."
      : null);

  return {
    rows,
    gapAreas,
    spreadMax,
    emptyReason: {
      imbalance: noLevels,
      wholeBook: nothing
        ?? (wholeBookFrames === 0
          ? "No frame in this session carries a usable whole-book total. A zero total is a feed dropout, and the collector did not record totals at all before 2026-09-17."
          : null),
      spread: noLevels,
      mid: noLevels,
    },
  };
}

/**
 * True when a point has a value but neither neighbour does, so a line through it draws nothing.
 *
 * Lines are cut at every gap and at every bucket with no usable frame, so a sparse day, or one stray frame between
 * two holes, leaves points that no segment reaches. They are drawn as dots; connected points are left to the line.
 */
export function isIsolatedPoint(
  rows: readonly HistoryChartRow[],
  index: number,
  pick: (row: HistoryChartRow) => number | null,
): boolean {
  const here = rows[index];
  if (!here || pick(here) === null) return false;
  const before = index > 0 ? pick(rows[index - 1]!) : null;
  const after = index < rows.length - 1 ? pick(rows[index + 1]!) : null;
  return before === null && after === null;
}

function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

const IST_CLOCK_WITH_SECONDS: Intl.DateTimeFormatOptions = {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
};

/** `HH:MM:SS` on the IST clock, for the buckets and gaps that are shorter than a minute. */
export function formatIstClock(epochMs: number): string {
  return Number.isFinite(epochMs) ? new Date(epochMs).toLocaleTimeString("en-GB", IST_CLOCK_WITH_SECONDS) : "—";
}

export interface HistoryNote {
  tone: "info" | "warn";
  text: string;
}

/**
 * What the chart stands on, in words: the frames it had to leave out, a doubled stream, and the flags it kept.
 * A count is shown only when it is not zero, so a clean session carries no noise.
 */
export function historyNotes(payload: DepthHistoryAvailable): HistoryNote[] {
  const { counts } = payload;
  const notes: HistoryNote[] = [];

  for (const pair of payload.concurrentWriters) {
    notes.push({
      tone: "warn",
      text: `Two capture sessions were writing at once for ${pair.overlapSeconds.toFixed(0)} s `
        + `(${formatIstClock(Date.parse(pair.overlapFrom))}–${formatIstClock(Date.parse(pair.overlapTo))} IST). `
        + "Frame counts and means inside that span mix two streams of the same contract.",
    });
  }
  if (counts.framesWithoutLevelMetrics > 0) {
    notes.push({
      tone: "info",
      text: `${counts.framesWithoutLevelMetrics.toLocaleString("en-IN")} of ${counts.framesInSession.toLocaleString("en-IN")} frames `
        + `(${percentOf(counts.framesWithoutLevelMetrics, counts.framesInSession)}) had a book that cannot be used for level figures `
        + "(crossed, out of order, or captured before 2026-09-07). They are left out of the spread, mid and level imbalances.",
    });
  }
  if (counts.framesWithoutWholeBook > 0) {
    notes.push({
      tone: "info",
      text: `${counts.framesWithoutWholeBook.toLocaleString("en-IN")} frames (${percentOf(counts.framesWithoutWholeBook, counts.framesInSession)}) `
        + "had no usable whole-book total (a total of zero is a feed dropout, not an empty side). They are left out of the whole-book line.",
    });
  }
  if (counts.framesOutsideSession > 0) {
    notes.push({
      tone: "info",
      text: `${counts.framesOutsideSession.toLocaleString("en-IN")} frames received outside 09:00–15:30 IST were not used.`,
    });
  }
  if (counts.framesFlaggedDuplicate > 0) {
    notes.push({
      tone: "info",
      text: `${counts.framesFlaggedDuplicate.toLocaleString("en-IN")} frames carry the collector's duplicate flag. They are kept: `
        + "the flag was set on nearly every frame on some days, so it cannot be used to filter.",
    });
  }
  return notes;
}

/** The text of a session in a drop-down: the date, the span captured, and a warning when the day is sparse. */
export function sessionOptionLabel(session: DepthHistorySessionSummary): string {
  const from = new Date(session.firstAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const to = new Date(session.lastAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  return `${session.sessionDate} · ${from}–${to} IST${session.sparse ? " · sparse (under 1,000 frames)" : ""}`;
}

/** Seconds a refresh has been outstanding: how old the data on screen is. Never negative. */
export function dataAgeSeconds(fetchedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000));
}
