/**
 * Order-flow imbalance from a sequence of order-book frames (Phase 28 step 3).
 *
 * OFI is the canonical Cont-Kukanov-Stoikov construction: for each book update, the change in
 * queue at the best quotes, signed by which side moved. At level one:
 *
 *   e = I{Pb >= Pb'} qb - I{Pb <= Pb'} qb' - I{Pa <= Pa'} qa + I{Pa >= Pa'} qa'
 *
 * which reads more plainly as three cases per side. A bid that ticks up adds its whole new size as
 * buy pressure; a bid holding its price contributes only the change in size; a bid that ticks down
 * removes the size that left. The ask mirrors it with the sign flipped.
 *
 * ## This is why Phase 1 stored sequencing, and it is not a formality
 *
 * OFI is a **cumulative sum over deltas**, so it is only defined along an unbroken chain of frames.
 * Three things break the chain, and all three are refusals here rather than approximations:
 *
 * - **A snapshot.** The feed re-bases the whole book, so the difference between the frame before it
 *   and the frame after it is not order flow — it is a re-statement. Differencing across it would
 *   invent an enormous imbalance out of nothing.
 * - **A sequence gap.** A missing frame means real queue changes happened that we never saw.
 *   Differencing across the hole attributes all of them to one update, and every subsequent value
 *   in the running sum inherits the error.
 * - **A duplicate.** A replayed frame differenced against its own predecessor contributes a second
 *   copy of the same flow.
 *
 * So `accumulateOrderFlowImbalance` emits **segments**, not one continuous series. Each segment is a
 * stretch over which the running sum is actually meaningful, and the breaks between them are
 * reported with their cause. A caller that wants one long series must decide how to treat the
 * discontinuities; it must not be handed a number that silently pretends they were not there.
 *
 * This is the payoff for the sequencing work in Phase 1. Without `gapBefore`, `isSnapshot` and
 * `isDuplicate` on every stored row, none of these breaks would be detectable after the fact, and an
 * OFI series computed over the table would look perfectly well-formed while being wrong wherever the
 * feed hiccuped.
 *
 * ## Multi-level, and the weighting question left open
 *
 * The same per-level arithmetic extends to deeper levels, and `multiLevelOrderFlowImbalance` returns
 * the per-level values plus their unweighted sum. Whether deeper levels *should* carry equal weight
 * is a modelling question with no settled answer — depth further from touch is both larger and less
 * informative — so the choice is deliberately left to the caller rather than baked in here with an
 * invented decay constant.
 */

/** The minimum a frame must expose for OFI. Satisfied by a stored `depth_frames` row. */
export interface OrderBookSide {
  readonly bidPrice: readonly number[];
  readonly bidQty: readonly number[];
  readonly askPrice: readonly number[];
  readonly askQty: readonly number[];
}

export interface OfiFrame extends OrderBookSide {
  readonly sequenceNo: number | null;
  readonly receivedAt: Date;
  readonly isSnapshot: boolean;
  readonly isDuplicate: boolean;
  /** Sequence numbers missing immediately before this frame; null when not comparable. */
  readonly gapBefore: number | null;
}

/**
 * The signed queue change at one level between two frames.
 *
 * Returns null when either frame lacks a usable price at that level: a level that does not exist on
 * one side cannot have a flow, and treating an absent price as 0 would read the level appearing as
 * an infinite improvement.
 */
export function levelOrderFlowImbalance(
  previous: OrderBookSide,
  current: OrderBookSide,
  level: number,
): number | null {
  const previousBidPrice = previous.bidPrice[level] ?? 0;
  const currentBidPrice = current.bidPrice[level] ?? 0;
  const previousAskPrice = previous.askPrice[level] ?? 0;
  const currentAskPrice = current.askPrice[level] ?? 0;
  if (previousBidPrice <= 0 || currentBidPrice <= 0) return null;
  if (previousAskPrice <= 0 || currentAskPrice <= 0) return null;

  const previousBidQty = previous.bidQty[level] ?? 0;
  const currentBidQty = current.bidQty[level] ?? 0;
  const previousAskQty = previous.askQty[level] ?? 0;
  const currentAskQty = current.askQty[level] ?? 0;

  let bidFlow: number;
  if (currentBidPrice > previousBidPrice) bidFlow = currentBidQty;
  else if (currentBidPrice < previousBidPrice) bidFlow = -previousBidQty;
  else bidFlow = currentBidQty - previousBidQty;

  let askFlow: number;
  if (currentAskPrice < previousAskPrice) askFlow = -currentAskQty;
  else if (currentAskPrice > previousAskPrice) askFlow = previousAskQty;
  else askFlow = -(currentAskQty - previousAskQty);

  return bidFlow + askFlow;
}

export interface MultiLevelOfi {
  /** Per-level values, index 0 being the touch. Null where a level was not comparable. */
  readonly perLevel: readonly (number | null)[];
  /** Unweighted sum of the comparable levels. Null when none were comparable. */
  readonly total: number | null;
  readonly levelsCompared: number;
}

export function multiLevelOrderFlowImbalance(
  previous: OrderBookSide,
  current: OrderBookSide,
  levels: number,
): MultiLevelOfi {
  if (!Number.isInteger(levels) || levels < 1) {
    throw new Error("levels must be a positive integer.");
  }

  const perLevel: (number | null)[] = [];
  let total = 0;
  let levelsCompared = 0;

  for (let level = 0; level < levels; level += 1) {
    const value = levelOrderFlowImbalance(previous, current, level);
    perLevel.push(value);
    if (value !== null) {
      total += value;
      levelsCompared += 1;
    }
  }

  return { perLevel, total: levelsCompared === 0 ? null : total, levelsCompared };
}

/** Why a run of frames could not be continued. */
export type OfiBreakCause = "SNAPSHOT" | "SEQUENCE_GAP" | "DUPLICATE" | "NOT_COMPARABLE";

export interface OfiObservation {
  readonly at: Date;
  readonly sequenceNo: number | null;
  /** Index into the input frames, so a caller can recover the book this increment came from. */
  readonly frameIndex: number;
  /** The increment contributed by this frame. */
  readonly delta: number;
  /** Running sum within this segment only. */
  readonly cumulative: number;
}

export interface OfiSegment {
  /** Why the chain restarted here. `SNAPSHOT` for the first segment of a normal capture. */
  readonly startedBecause: OfiBreakCause;
  readonly observations: readonly OfiObservation[];
}

export interface OfiBreak {
  readonly at: Date;
  readonly sequenceNo: number | null;
  readonly cause: OfiBreakCause;
  /** Missing sequence numbers, when the cause was a gap. */
  readonly missedSequences: number | null;
}

export interface OfiAccumulation {
  readonly segments: readonly OfiSegment[];
  readonly breaks: readonly OfiBreak[];
  readonly framesExamined: number;
  /** Observations across all segments. Always <= framesExamined. */
  readonly observations: number;
  /** Longest segment, in observations. What a window-based feature actually has to work with. */
  readonly longestSegment: number;
}

export interface AccumulateOfiOptions {
  /** Levels to include in each increment. Defaults to the touch alone. */
  readonly levels?: number;
}

/**
 * Splits a frame series into segments over which a cumulative OFI is defined, and reports the breaks.
 *
 * Frames must arrive in capture order. The first frame of any segment establishes a baseline and
 * contributes no observation of its own — there is nothing to difference it against.
 */
export function accumulateOrderFlowImbalance(
  frames: readonly OfiFrame[],
  options: AccumulateOfiOptions = {},
): OfiAccumulation {
  const levels = options.levels ?? 1;
  if (!Number.isInteger(levels) || levels < 1) {
    throw new Error("levels must be a positive integer.");
  }

  const segments: OfiSegment[] = [];
  const breaks: OfiBreak[] = [];

  let currentObservations: OfiObservation[] = [];
  let currentStartedBecause: OfiBreakCause = "SNAPSHOT";
  let previous: OfiFrame | null = null;
  let runningSum = 0;
  let observationCount = 0;
  let frameIndex = -1;

  const closeSegment = (): void => {
    if (currentObservations.length > 0) {
      segments.push({ startedBecause: currentStartedBecause, observations: currentObservations });
    }
    currentObservations = [];
    runningSum = 0;
  };

  for (const frame of frames) {
    frameIndex += 1;
    const breaksChain: OfiBreakCause | null = frame.isDuplicate
      ? "DUPLICATE"
      : frame.isSnapshot
        ? "SNAPSHOT"
        : (frame.gapBefore !== null && frame.gapBefore > 0)
          ? "SEQUENCE_GAP"
          : null;

    if (breaksChain !== null) {
      // Only a break if there was a chain to break. The opening frame of a capture is a snapshot by
      // design, and recording it as a discontinuity would report every clean capture as damaged --
      // and would mean no capture could ever have zero breaks.
      if (previous !== null) {
        breaks.push({
          at: frame.receivedAt,
          sequenceNo: frame.sequenceNo,
          cause: breaksChain,
          missedSequences: breaksChain === "SEQUENCE_GAP" ? frame.gapBefore : null,
        });
        closeSegment();
        currentStartedBecause = breaksChain;
      }
      // A duplicate is not a valid baseline either -- it restates a book we already had, so the
      // next real frame would difference against a stale copy. Skip it entirely.
      previous = breaksChain === "DUPLICATE" ? previous : frame;
      continue;
    }

    if (previous === null) {
      previous = frame;
      continue;
    }

    const increment = multiLevelOrderFlowImbalance(previous, frame, levels);
    if (increment.total === null) {
      // No comparable level: a one-sided or empty book. The chain cannot continue through it,
      // because the next frame would difference against a book we could not read.
      breaks.push({
        at: frame.receivedAt,
        sequenceNo: frame.sequenceNo,
        cause: "NOT_COMPARABLE",
        missedSequences: null,
      });
      closeSegment();
      currentStartedBecause = "NOT_COMPARABLE";
      previous = frame;
      continue;
    }

    runningSum += increment.total;
    currentObservations.push({
      at: frame.receivedAt,
      sequenceNo: frame.sequenceNo,
      frameIndex,
      delta: increment.total,
      cumulative: runningSum,
    });
    observationCount += 1;
    previous = frame;
  }

  closeSegment();

  return {
    segments,
    breaks,
    framesExamined: frames.length,
    observations: observationCount,
    longestSegment: segments.reduce(
      (longest, segment) => Math.max(longest, segment.observations.length),
      0,
    ),
  };
}
