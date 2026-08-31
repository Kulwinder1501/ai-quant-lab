/**
 * Whether a bar series was actually moving, or was republishing one price.
 *
 * ## The defect this exists for
 *
 * From 2026-08-03 the index feed freezes daily from the 15:16 bar to the close: it keeps publishing
 * bars, on time, with correct timestamps, and every one of them repeats the last real print.
 * Measured on 1m NIFTY50 and BANKNIFTY over the 21 days to 2026-08-31, the 14 bars from 15:16 to
 * 15:29 collapse to **two distinct closes per instrument per day**, every day.
 *
 * `GRID_POLICY_V1` admits decisions in `(09:15, 15:30]`, so those minutes are decision slots, and
 * 41 proposals had already been recorded inside the frozen window before this gate existed.
 *
 * Nothing upstream catches it, and that is the point worth stating precisely: this is staleness by
 * *value*, not by clock. The bars are present, complete, and correctly stamped, so a freshness check
 * on `dataThrough` passes, feature warmup passes, and grid alignment passes. Every existing gate is
 * answering a question the frozen tape does not fail.
 *
 * ## Why the test is value repetition and not zero volume
 *
 * Zero volume looks like the obvious signal and it is the wrong one. On 2026-08-31 NIFTY50 carried
 * 348M of volume across the frozen window and still printed only two distinct closes; across the
 * 21-day sample the per-minute zero-volume rate falls from 15/15 at 15:16-15:19 to 7/15 by 15:29.
 * A volume test would have passed the tape on exactly the days it most needed to fail it.
 *
 * ## Why the threshold is two bars
 *
 * Measured, not chosen. Runs of consecutive OHLC-identical 1m bars, both indices, 21 days:
 *
 *   zone                    runs    longest run   mean   p99
 *   healthy 09:16-15:15    10,800             1   1.00     1
 *   frozen  15:16-15:29        72            13   5.83    13
 *
 * Not one repeated bar in 10,800 healthy runs. So "this bar is OHLC-identical to the bar before it"
 * separates the two populations with no observed false positive, and a threshold of two is the
 * earliest point at which the freeze is detectable at all.
 *
 * The comparison is on all four of open/high/low/close rather than close alone. That is the stricter
 * reading -- some frozen days carry three distinct OHLC tuples against two distinct closes, so OHLC
 * flags slightly less often -- and it still separates the populations completely. Preferring the
 * stricter test means a genuinely thin but moving market is not called frozen.
 *
 * The calibration is on index 1m bars. An illiquid single stock could legitimately print identical
 * consecutive minutes, so the threshold is exported rather than inlined: a caller extending this
 * beyond the indices must re-measure before trusting the default.
 */

export type ResearchTapeLiveness = "LIVE" | "FROZEN";

/**
 * Versioned because it changes what a control point asserts, and reported so a capture run says
 * which tape rule was in force.
 *
 * Deliberately **not** a component of `controlPointKey`. That follows the rule `settlementPolicyVersion`
 * already sets for `fillPolicyVersion`: putting a component version into an identity key lets one
 * population version coexist under two different component rules as two separate keys, so the
 * database quietly holds both instead of rejecting the second. The binding runs the other way
 * instead --
 *
 * > if this rule or `frozenTapeIdenticalBarThreshold` changes, `controlPolicyVersion` MUST change.
 *
 * -- so a control point's population version stays sufficient to say what its eligibility meant.
 */
export const tapeLivenessPolicyVersion = "TAPE_LIVENESS_V1";

/** Consecutive OHLC-identical bars, inclusive of the reference bar, that mean the tape is frozen. */
export const frozenTapeIdenticalBarThreshold = 2;

export interface TapeBar {
  readonly openTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface TapeLivenessAssessment {
  readonly liveness: ResearchTapeLiveness;
  /**
   * Length of the trailing run of OHLC-identical, time-contiguous bars, counting the reference bar.
   *
   * Always at least 1. Capped by how many bars the caller supplied, so it is a diagnostic rather
   * than a measurement of how long the freeze has run -- which is exactly why it is not part of the
   * ineligibility reason string.
   */
  readonly identicalBars: number;
}

function sameBarValues(left: TapeBar, right: TapeBar): boolean {
  return left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close;
}

/**
 * Classifies the tape at the newest bar in `bars`.
 *
 * `bars` is chronological, oldest first, and its last element is the reference bar being judged. A
 * gap breaks the run: two OHLC-identical bars that are not `intervalMs` apart are not evidence of a
 * frozen tape, they are evidence of a missing bar, which is a different defect measured elsewhere.
 * Walking backwards and stopping at the first break means a caller cannot manufacture a run by
 * passing a non-contiguous window.
 *
 * A single bar is `LIVE` with `identicalBars: 1`. That is deliberate and not a gap in the check: the
 * first bar of a session has nothing to be identical to, and refusing it would discard 09:16 every
 * day to guard against a freeze that by construction cannot yet be visible. The freeze this targets
 * runs for fourteen consecutive minutes, so it is still caught one bar later.
 */
export function assessTapeLiveness(input: {
  readonly bars: readonly TapeBar[];
  readonly intervalMs: number;
  readonly threshold?: number;
}): TapeLivenessAssessment {
  if (input.bars.length === 0) {
    throw new Error("Tape liveness requires at least the reference bar.");
  }
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("Tape liveness requires a positive bar interval.");
  }
  const threshold = input.threshold ?? frozenTapeIdenticalBarThreshold;
  if (!Number.isInteger(threshold) || threshold < 2) {
    // A threshold of 1 would call every bar frozen, since a bar is trivially identical to itself.
    throw new Error("A frozen-tape threshold below 2 bars cannot distinguish anything.");
  }

  let identicalBars = 1;
  for (let index = input.bars.length - 1; index > 0; index -= 1) {
    const newer = input.bars[index]!;
    const older = input.bars[index - 1]!;
    const contiguous = newer.openTime.getTime() - older.openTime.getTime() === input.intervalMs;
    if (!contiguous || !sameBarValues(newer, older)) break;
    identicalBars += 1;
  }

  return {
    liveness: identicalBars >= threshold ? "FROZEN" : "LIVE",
    identicalBars,
  };
}
