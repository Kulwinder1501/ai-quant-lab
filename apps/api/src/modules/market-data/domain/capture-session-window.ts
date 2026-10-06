/**
 * Summarises which capture sessions landed inside a `--from`/`--to` window, and flags concurrent
 * writers -- the range-query equivalent of `countForeignRowsInWindow` (Phase 28).
 *
 * ## Why a range query needs its own contamination check
 *
 * `evaluate-ofi-signal.ts` can scope a read either to one `captureSessionId` or to a `--from`/`--to`
 * window. The single-session path already has `countForeignRowsInWindow`: a non-zero count means
 * another collector wrote into the same interval, so the series mixes two writers. That check is
 * meaningless for a window-scoped read *by construction* -- a window spanning several sequential
 * collector restarts is expected to contain many distinct `captureSessionId`s, and flagging every one
 * of them as "foreign" would refuse the exact query this module exists to allow.
 *
 * What a window-scoped read still must not tolerate is two *different* sessions whose time ranges
 * **overlap** -- that is not a sequence of restarts, it is two collectors running against the same
 * contract at once (a bad deploy that didn't tear down the old container first, say), and a feature
 * or health computation over the pooled frames would silently interleave two independent streams.
 * Sequential sessions (one ends, a gap, the next begins) are exactly what this evaluation is meant to
 * pool; overlapping ones are exactly what it must refuse.
 *
 * ## What this does not need to check
 *
 * It does not need to guard the OFI feature or forward-return computation against reaching across the
 * gap between sessions -- `order-flow-imbalance.ts` already breaks its running sum at any frame whose
 * `isSnapshot` is true (every session's first frame), and `ofi-signal-observations.ts`'s forward-frame
 * search already refuses an endpoint that lands outside `horizonToleranceMs`, which a
 * multi-hour-to-multi-day collector-restart gap always does. This module is purely about detecting
 * *contamination* (two writers at once), not about gap-safety, which was already handled.
 */

export interface CaptureSessionWindowFrame {
  readonly captureSessionId: string;
  readonly receivedAt: Date;
}

export interface CaptureSessionSummary {
  readonly captureSessionId: string;
  readonly firstAt: Date;
  readonly lastAt: Date;
  readonly frames: number;
}

export interface OverlappingSessionPair {
  readonly sessionA: string;
  readonly sessionB: string;
  readonly overlapFrom: Date;
  readonly overlapTo: Date;
}

/** Groups frames by `captureSessionId`, sorted by first appearance. */
export function summariseCaptureSessions(
  frames: readonly CaptureSessionWindowFrame[],
): CaptureSessionSummary[] {
  const bySession = new Map<string, { firstAt: Date; lastAt: Date; frames: number }>();

  for (const frame of frames) {
    const existing = bySession.get(frame.captureSessionId);
    if (existing === undefined) {
      bySession.set(frame.captureSessionId, {
        firstAt: frame.receivedAt, lastAt: frame.receivedAt, frames: 1,
      });
      continue;
    }
    if (frame.receivedAt.getTime() < existing.firstAt.getTime()) existing.firstAt = frame.receivedAt;
    if (frame.receivedAt.getTime() > existing.lastAt.getTime()) existing.lastAt = frame.receivedAt;
    existing.frames += 1;
  }

  return Array.from(bySession.entries())
    .map(([captureSessionId, summary]) => ({ captureSessionId, ...summary }))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
}

/**
 * Every pair of distinct sessions whose `[firstAt, lastAt]` intervals intersect.
 *
 * O(n log n + k) where k is the number of overlapping pairs found: sessions are sorted by `firstAt`,
 * so once a later session's `firstAt` passes the earlier one's `lastAt` no further session can overlap
 * it either (all later sessions start later still) and the inner scan stops.
 */
export function findOverlappingSessions(
  sessions: readonly CaptureSessionSummary[],
): OverlappingSessionPair[] {
  const sorted = [...sessions].sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
  const overlaps: OverlappingSessionPair[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (b.firstAt.getTime() > a.lastAt.getTime()) break;
      overlaps.push({
        sessionA: a.captureSessionId,
        sessionB: b.captureSessionId,
        overlapFrom: b.firstAt,
        overlapTo: a.lastAt.getTime() < b.lastAt.getTime() ? a.lastAt : b.lastAt,
      });
    }
  }

  return overlaps;
}
