import { microprice } from "../../market-data/domain/depth-frame.js";
import {
  accumulateOrderFlowImbalance,
  type OfiFrame,
} from "./order-flow-imbalance.js";
import { inspectPointInTime, type LookaheadViolation } from "./lookahead-guard.js";
import type { FalsificationObservation } from "./falsification-harness.js";

/**
 * Pairs a trailing OFI feature with a forward microprice return, for the R0 harness.
 *
 * This is the join where look-ahead bugs actually live, so the rules are stated rather than implied.
 *
 * ## The feature may not cross an OFI break; the return may
 *
 * These are different quantities with different failure modes, and treating them the same is wrong
 * in one direction or the other.
 *
 * The **feature** is a sum of deltas, so it inherits everything `order-flow-imbalance.ts` refuses:
 * it is accumulated strictly within one segment, and a window that would reach back across a
 * snapshot, a gap or a duplicate is truncated at the segment boundary rather than reaching through
 * it. A window shorter than requested is honest; a window that spans a hole is not.
 *
 * The **return** is a difference of two prices, and a price is a price. A gap between the endpoints
 * means we did not observe the path, but both endpoints are still real observations, so the return
 * is measured across breaks. Refusing returns across gaps would silently drop exactly the volatile
 * moments the feed is most likely to hiccup through, which is a selection bias on the label.
 *
 * ## Point-in-time, asserted rather than assumed
 *
 * `featureAsOf` is the timestamp of the last frame contributing to the trailing window, and
 * `decidedAt` is the same instant: the decision is taken on the frame that completes the feature.
 * The forward endpoint must be **strictly later** than that instant — not equal — because a frame
 * bearing the same millisecond stamp could have been processed either side of the decision, and
 * "probably after" is not a basis for a label. Every observation is run through
 * `inspectPointInTime`, and violations are returned rather than thrown so a whole run can be audited
 * at once.
 *
 * ## Horizon is in time, not in frames
 *
 * A frame-count horizon means different clock time depending on how busy the book was, so it
 * correlates the label with activity — and activity correlates with the feature. That is a subtle
 * way to manufacture an IC. The horizon is therefore milliseconds, and the endpoint is the first
 * frame at or after it, subject to a tolerance; if the next frame is beyond the tolerance the
 * observation is dropped rather than stretched.
 */

export interface BuildOfiObservationsInput {
  readonly frames: readonly OfiFrame[];
  /** Trailing window over which OFI deltas are summed, in milliseconds. */
  readonly ofiWindowMs: number;
  /** Forward horizon for the return, in milliseconds. */
  readonly horizonMs: number;
  /** How far past the horizon an endpoint frame may sit before the observation is dropped. */
  readonly horizonToleranceMs?: number;
  /** Levels included in each OFI increment. */
  readonly levels?: number;
}

export type OfiObservationSkipReason =
  | "NO_FORWARD_FRAME_IN_TOLERANCE"
  | "UNREADABLE_MICROPRICE"
  | "ZERO_BASE_PRICE"
  | "LOOKAHEAD_VIOLATION";

export interface OfiObservationSet {
  readonly observations: readonly FalsificationObservation[];
  readonly skipped: Readonly<Record<OfiObservationSkipReason, number>>;
  /** Violations found while building. Non-empty means the pipeline, not the market, is the problem. */
  readonly lookaheadViolations: readonly LookaheadViolation[];
  readonly segmentsUsed: number;
  readonly framesExamined: number;
}

export function buildOfiObservations(input: BuildOfiObservationsInput): OfiObservationSet {
  const tolerance = input.horizonToleranceMs ?? Math.max(1_000, Math.floor(input.horizonMs / 2));
  if (!Number.isFinite(input.ofiWindowMs) || input.ofiWindowMs <= 0) {
    throw new Error("ofiWindowMs must be positive.");
  }
  if (!Number.isFinite(input.horizonMs) || input.horizonMs <= 0) {
    throw new Error("horizonMs must be positive.");
  }

  const accumulation = accumulateOrderFlowImbalance(input.frames, { levels: input.levels ?? 1 });

  const observations: FalsificationObservation[] = [];
  const lookaheadViolations: LookaheadViolation[] = [];
  const skipped: Record<OfiObservationSkipReason, number> = {
    NO_FORWARD_FRAME_IN_TOLERANCE: 0,
    UNREADABLE_MICROPRICE: 0,
    ZERO_BASE_PRICE: 0,
    LOOKAHEAD_VIOLATION: 0,
  };

  // Microprice per frame, computed once. Null where the book was one-sided.
  const prices = input.frames.map((frame) => microprice(frame));

  /** First frame strictly after `fromMs + horizon`, within tolerance. */
  const findForwardFrame = (startIndex: number, fromMs: number): number | null => {
    const target = fromMs + input.horizonMs;
    for (let index = startIndex + 1; index < input.frames.length; index += 1) {
      const at = input.frames[index]!.receivedAt.getTime();
      // Strictly later than the decision instant, never equal: a same-millisecond frame could have
      // been processed either side of the decision.
      if (at <= fromMs) continue;
      if (at < target) continue;
      return at - target <= tolerance ? index : null;
    }
    return null;
  };

  for (const segment of accumulation.segments) {
    const withinSegment = segment.observations;
    // Two pointers over the segment: `windowStart` trails `cursor` by at most ofiWindowMs. The sum
    // is maintained incrementally so a long segment does not become quadratic.
    let windowStart = 0;
    let windowSum = 0;

    for (let cursor = 0; cursor < withinSegment.length; cursor += 1) {
      const current = withinSegment[cursor]!;
      windowSum += current.delta;

      const cutoff = current.at.getTime() - input.ofiWindowMs;
      while (windowStart < cursor && withinSegment[windowStart]!.at.getTime() < cutoff) {
        windowSum -= withinSegment[windowStart]!.delta;
        windowStart += 1;
      }

      const decidedAtMs = current.at.getTime();
      const basePrice = prices[current.frameIndex];
      if (basePrice === null || basePrice === undefined) {
        skipped.UNREADABLE_MICROPRICE += 1;
        continue;
      }
      if (basePrice <= 0) {
        skipped.ZERO_BASE_PRICE += 1;
        continue;
      }

      const forwardIndex = findForwardFrame(current.frameIndex, decidedAtMs);
      if (forwardIndex === null) {
        skipped.NO_FORWARD_FRAME_IN_TOLERANCE += 1;
        continue;
      }
      const forwardPrice = prices[forwardIndex];
      if (forwardPrice === null || forwardPrice === undefined || forwardPrice <= 0) {
        skipped.UNREADABLE_MICROPRICE += 1;
        continue;
      }

      const featureAsOf = current.at;
      const violation = inspectPointInTime({
        label: `ofi observation at frame ${current.frameIndex}`,
        featureAsOf,
        decidedAt: current.at,
      });
      if (violation) {
        lookaheadViolations.push(violation);
        skipped.LOOKAHEAD_VIOLATION += 1;
        continue;
      }

      observations.push({
        at: current.at,
        featureAsOf,
        featureValue: windowSum,
        forwardReturn: (forwardPrice - basePrice) / basePrice,
      });
    }
  }

  return {
    observations,
    skipped,
    lookaheadViolations,
    segmentsUsed: accumulation.segments.length,
    framesExamined: accumulation.framesExamined,
  };
}
