/**
 * Sequence-continuity analysis for a raw depth feed.
 *
 * Phase 28's first gate is not "can we store depth" but "can we prove what we stored is intact".
 * This module answers that, and it is deliberately the part with no network and no database in it.
 *
 * ## Why a missing frame matters more here than a missing bar
 *
 * A gap in a candle series self-heals: the historical endpoint can be re-fetched, and
 * `CANDLE_GAP_HEAL` already does exactly that nightly. A gap in a depth stream cannot. Order-flow
 * imbalance is a **cumulative sum over deltas**, so one dropped incremental frame does not corrupt
 * one observation — it corrupts the running book from that point until the next snapshot re-bases
 * it. The blast radius of a single loss is bounded by snapshot cadence, not by one row.
 *
 * That asymmetry is why the tolerance below is strict, and why `missedSequenceRate` rather than
 * `gapEventRate` is the number the verdict keys on. Ten scattered single-frame losses and one
 * ten-frame burst are the same `gapEventRate` story only if you are counting events; they are very
 * different stories for a reconstructed book.
 *
 * ## A snapshot is not a gap
 *
 * The feed sends a snapshot first and increments from there, and it re-snapshots after a
 * reconnection. The sequence number can therefore jump arbitrarily across a snapshot boundary
 * legitimately. Treating that jump as loss would report a feed as broken every time it recovered
 * correctly — so a snapshot frame reports `gapBefore: null` (nothing comparable) rather than a
 * gap. This is the single most likely source of a false alarm in this module.
 *
 * ## Thresholds are pre-registered, and they are judgement calls
 *
 * The two rates below are declared before the first session is captured, so they cannot be relaxed
 * to make a disappointing capture look acceptable. They are not derived from theory: 0.1% and 1%
 * are engineering judgement about how much re-basing a research pipeline can absorb. They are
 * stated as options so a future run can tighten them, and named in the output so any verdict can be
 * re-read against a different bar.
 */

/** Above this fraction of the stream missing, a reconstructed book is not trustworthy. */
export const DEFAULT_NOT_RECONSTRUCTIBLE_RATE = 0.01;
/** Above this, usable but worth reporting alongside any result derived from it. */
export const DEFAULT_DEGRADED_RATE = 0.001;
/** Below this many comparable pairs, no rate is published at all. */
export const DEFAULT_MINIMUM_COMPARABLE_PAIRS = 500;

export interface SequenceClassification {
  /**
   * Sequence numbers skipped immediately before this frame. `0` means contiguous. `null` means
   * nothing was comparable — no predecessor, a snapshot boundary, a missing sequence number, or a
   * regression, all of which are reported through their own fields instead.
   */
  readonly gapBefore: number | null;
  /** Same sequence number as its predecessor: the feed replayed a frame. */
  readonly isDuplicate: boolean;
  /** Lower sequence number than its predecessor: out-of-order delivery or an unflagged restart. */
  readonly isRegression: boolean;
}

export interface ClassifySequenceInput {
  readonly sequenceNo: number | null;
  /** The previous accepted frame's sequence number for this symbol, or null if this is the first. */
  readonly previousSequenceNo: number | null;
  readonly isSnapshot: boolean;
}

function isUsableSequence(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

export function classifySequence(input: ClassifySequenceInput): SequenceClassification {
  const clean: SequenceClassification = { gapBefore: null, isDuplicate: false, isRegression: false };

  // A frame without a usable sequence number tells us nothing about continuity. Recorded, not
  // guessed at: inventing a gap of 0 here would inflate the contiguous count with unknowns.
  if (!isUsableSequence(input.sequenceNo)) return clean;

  // A snapshot legitimately re-bases the stream. See the header.
  if (input.isSnapshot) return clean;

  if (!isUsableSequence(input.previousSequenceNo)) return clean;

  if (input.sequenceNo === input.previousSequenceNo) {
    return { gapBefore: 0, isDuplicate: true, isRegression: false };
  }
  if (input.sequenceNo < input.previousSequenceNo) {
    return { gapBefore: null, isDuplicate: false, isRegression: true };
  }
  return {
    gapBefore: input.sequenceNo - input.previousSequenceNo - 1,
    isDuplicate: false,
    isRegression: false,
  };
}

export type SequenceHealthVerdict =
  | "RECONSTRUCTIBLE"
  | "DEGRADED"
  | "FEED_NOT_RECONSTRUCTIBLE"
  | "INSUFFICIENT_SAMPLE";

/** One already-classified frame, as persisted. */
export interface ClassifiedFrame {
  readonly gapBefore: number | null;
  readonly isDuplicate: boolean;
  readonly isRegression: boolean;
  readonly isSnapshot: boolean;
  readonly sequenceNo: number | null;
}

export interface SequenceHealth {
  readonly framesExamined: number;
  readonly framesWithSequence: number;
  readonly snapshots: number;
  /** Frames where a gap could actually be computed. The denominator for every rate below. */
  readonly comparablePairs: number;
  readonly contiguousFrames: number;
  /** Frames preceded by at least one missing sequence number. */
  readonly gapEvents: number;
  /** Total sequence numbers never seen. The number that bounds book reconstruction. */
  readonly missedSequences: number;
  readonly duplicates: number;
  readonly regressions: number;
  /** Fraction of comparable frames that were preceded by a gap. */
  readonly gapEventRate: number | null;
  /**
   * Fraction of the expected sequence stream that never arrived:
   * `missed / (missed + comparable)`. This is what the verdict keys on.
   */
  readonly missedSequenceRate: number | null;
  /** Largest single burst of consecutive missing sequence numbers. */
  readonly largestGap: number;
  readonly verdict: SequenceHealthVerdict;
  readonly thresholds: {
    readonly degradedRate: number;
    readonly notReconstructibleRate: number;
    readonly minimumComparablePairs: number;
  };
}

export interface SequenceHealthOptions {
  readonly degradedRate?: number;
  readonly notReconstructibleRate?: number;
  readonly minimumComparablePairs?: number;
}

/**
 * The Phase 1 gate metric: whether a captured session can carry order-flow research.
 *
 * Returns `INSUFFICIENT_SAMPLE` rather than a flattering rate on a thin capture. A gap rate over a
 * few dozen frames is not a characterisation of a feed, and publishing one would invite exactly the
 * "we checked, it's fine" conclusion this gate exists to prevent.
 */
export function summariseSequenceHealth(
  frames: readonly ClassifiedFrame[],
  options: SequenceHealthOptions = {},
): SequenceHealth {
  const degradedRate = options.degradedRate ?? DEFAULT_DEGRADED_RATE;
  const notReconstructibleRate = options.notReconstructibleRate ?? DEFAULT_NOT_RECONSTRUCTIBLE_RATE;
  const minimumComparablePairs = options.minimumComparablePairs ?? DEFAULT_MINIMUM_COMPARABLE_PAIRS;

  let framesWithSequence = 0;
  let snapshots = 0;
  let comparablePairs = 0;
  let contiguousFrames = 0;
  let gapEvents = 0;
  let missedSequences = 0;
  let duplicates = 0;
  let regressions = 0;
  let largestGap = 0;

  for (const frame of frames) {
    if (isUsableSequence(frame.sequenceNo)) framesWithSequence += 1;
    if (frame.isSnapshot) snapshots += 1;
    if (frame.isDuplicate) duplicates += 1;
    if (frame.isRegression) regressions += 1;

    if (frame.gapBefore === null) continue;
    comparablePairs += 1;
    if (frame.gapBefore === 0) {
      contiguousFrames += 1;
      continue;
    }
    gapEvents += 1;
    missedSequences += frame.gapBefore;
    if (frame.gapBefore > largestGap) largestGap = frame.gapBefore;
  }

  const expectedStream = missedSequences + comparablePairs;
  const gapEventRate = comparablePairs === 0 ? null : gapEvents / comparablePairs;
  const missedSequenceRate = expectedStream === 0 ? null : missedSequences / expectedStream;

  let verdict: SequenceHealthVerdict;
  if (comparablePairs < minimumComparablePairs || missedSequenceRate === null) {
    verdict = "INSUFFICIENT_SAMPLE";
  } else if (missedSequenceRate > notReconstructibleRate) {
    verdict = "FEED_NOT_RECONSTRUCTIBLE";
  } else if (missedSequenceRate > degradedRate) {
    verdict = "DEGRADED";
  } else {
    verdict = "RECONSTRUCTIBLE";
  }

  return {
    framesExamined: frames.length,
    framesWithSequence,
    snapshots,
    comparablePairs,
    contiguousFrames,
    gapEvents,
    missedSequences,
    duplicates,
    regressions,
    gapEventRate,
    missedSequenceRate,
    largestGap,
    verdict,
    thresholds: { degradedRate, notReconstructibleRate, minimumComparablePairs },
  };
}
