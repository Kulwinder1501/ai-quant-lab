import type { ObservationSource, PatternSessionSegment } from "./contracts.js";

/**
 * The IST session boundaries that decide `PatternContext.sessionSegment`.
 *
 * ## Why these numbers live here and not in a comment
 *
 * Section 4 of the V1.0.1 spec defines `sessionSegment` as "determined by dataThrough vs IST
 * boundaries in Section 2.3", and Section 2.3 states no boundaries at all. The original
 * implementation invented them in a docstring above `determineSessionSegment`, which meant the
 * segment assignment — a field covered by `observationHash` — was specified nowhere. Two conforming
 * implementations would have disagreed on every bar between 10:00 and 14:00 and produced different
 * hashes for the identical observation.
 *
 * These are now the frozen boundaries, promoted from that comment and reconciled with the V1.0.1
 * Implementation Errata (Section 5). Changing any of them changes `observationHash` for every
 * observation in the affected window, so a change is a new encoding version, never an edit.
 *
 * ## The session end is instrument-dependent
 *
 * The errata separates the two: cash equities and index close at 15:30 IST, equity derivatives at
 * 15:40. The original code had a single flat rule — everything at or after 14:00 was `CLOSING`, with
 * no upper bound at all — so a bar stamped 22:00, or a weekend bar from a bad backfill, was silently
 * labelled `CLOSING` and observed as if it were a real closing-hour pattern. That is the same
 * ambiguity-of-absence failure the module has elsewhere: "outside the session" and "late in the
 * session" became the same value.
 *
 * `sessionSegmentOf` therefore returns `null` outside the observable session rather than guessing,
 * and the detector refuses to emit for such a bar. Absent is not `CLOSING`.
 *
 * ## PRE_OPEN can never carry a profile, by construction
 *
 * Section 8 pins `sessionTemplate: "CONTINUOUS_ONLY_0915_1540_IST"`, and errata Section 5 confirms
 * pre-open auction prints are excluded from continuous volume profiles and ORB calculations. So the
 * `PRE_OPEN` segment is reachable for non-profile families and unreachable for any profile-derived
 * one. That is intended: pre-open is a call auction, not continuous trading, and folding its single
 * uncrossing print into a continuous profile would misstate every level derived from it.
 */

/** Minutes past IST midnight. 09:00 IST. */
export const preOpenStartMinuteIst = 9 * 60;
/** 09:15 IST — the continuous session opens and the pre-open auction ends. */
export const continuousOpenMinuteIst = 9 * 60 + 15;
/** 10:00 IST — OPENING gives way to MIDDAY. */
export const middayStartMinuteIst = 10 * 60;
/** 14:00 IST — MIDDAY gives way to CLOSING. */
export const closingStartMinuteIst = 14 * 60;
/** 15:30 IST — cash equity and index continuous close. */
export const cashCloseMinuteIst = 15 * 60 + 30;
/** 15:40 IST — equity derivatives (FUTIDX) continuous close. */
export const derivativesCloseMinuteIst = 15 * 60 + 40;

const istOffsetMs = 5.5 * 60 * 60 * 1000;

/** The last minute of the continuous session for this instrument type, per errata Section 5. */
export function sessionCloseMinuteIst(instrumentType: ObservationSource["instrumentType"]): number {
  return instrumentType === "FUTIDX" ? derivativesCloseMinuteIst : cashCloseMinuteIst;
}

/** Minutes past IST midnight for a UTC instant. */
export function istMinuteOfDay(date: Date): number {
  const istDate = new Date(date.getTime() + istOffsetMs);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

/**
 * The segment a bar falls in, or `null` when the bar sits outside the observable session.
 *
 * `null` is a refusal, not a default. A caller must not substitute a segment for it — the detector
 * declines to emit an observation for that bar instead.
 */
export function sessionSegmentOf(
  date: Date,
  instrumentType: ObservationSource["instrumentType"],
): PatternSessionSegment | null {
  if (Number.isNaN(date.getTime())) return null;
  const minuteOfDay = istMinuteOfDay(date);
  const close = sessionCloseMinuteIst(instrumentType);

  if (minuteOfDay < preOpenStartMinuteIst || minuteOfDay >= close) return null;
  if (minuteOfDay < continuousOpenMinuteIst) return "PRE_OPEN";
  if (minuteOfDay < middayStartMinuteIst) return "OPENING";
  if (minuteOfDay < closingStartMinuteIst) return "MIDDAY";
  return "CLOSING";
}

/** Whether a bar is inside the continuous session, excluding the pre-open auction window. */
export function isContinuousSession(
  date: Date,
  instrumentType: ObservationSource["instrumentType"],
): boolean {
  const minuteOfDay = istMinuteOfDay(date);
  return minuteOfDay >= continuousOpenMinuteIst && minuteOfDay < sessionCloseMinuteIst(instrumentType);
}
