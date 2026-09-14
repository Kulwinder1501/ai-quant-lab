import { horizonEndUtc } from "./outcome-model.js";
import { utcDateKey, type OutcomeType } from "./returns.js";
import type { PredictionSnapshot } from "./snapshot.js";
import { unavailableReason } from "./snapshot.js";
import type { PredictionSnapshotStatus } from "./status.js";
import type { PointInTimeClocks } from "./timestamps.js";

export const decayMarkKinds = ["WEEKLY_MTM", "HORIZON_FINAL", "CORPORATE_EVENT"] as const;
export type DecayMarkKind = (typeof decayMarkKinds)[number];

/** Spec: weekly drawdown beyond 15% is flagged; beyond 25% overlays UNDER_REVIEW. */
export const DECAY_REVIEW_DRAWDOWN = -0.15;
export const DECAY_UNDER_REVIEW_DRAWDOWN = -0.25;
export const DECAY_WEEK_MS = 7 * 86_400_000;

export interface PredictionDecayMark extends PointInTimeClocks {
  readonly markId: string;
  readonly snapshotId: string;
  readonly markKind: DecayMarkKind;
  readonly asOf: Date;
  readonly forwardPriceReturn: number | null;
  readonly forwardTotalReturn: number | null;
  readonly maxDrawdown: number | null;
  readonly outcomeType: OutcomeType | null;
  readonly overlayStatus: PredictionSnapshotStatus | null;
  readonly reviewFlag: boolean;
}

export interface DisplayedSnapshot {
  readonly status: PredictionSnapshotStatus;
  readonly investorFacing: boolean;
  readonly overlayApplied: boolean;
  readonly unavailableReason: string | null;
}

export function weeklyDecaySchedule(predictionAsOf: Date, horizonEnd: Date): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(predictionAsOf.getTime() + DECAY_WEEK_MS);
  const horizonKey = utcDateKey(horizonEnd);
  while (utcDateKey(cursor) < horizonKey) {
    dates.push(cursor);
    cursor = new Date(cursor.getTime() + DECAY_WEEK_MS);
  }
  return dates;
}

export function decayScheduleForSnapshot(snapshot: Pick<PredictionSnapshot, "predictionAsOf" | "horizon">): {
  weekly: Date[];
  final: Date;
} {
  const final = horizonEndUtc(snapshot.predictionAsOf, snapshot.horizon);
  return { weekly: weeklyDecaySchedule(snapshot.predictionAsOf, final), final };
}

export function overlayFromDrawdown(maxDrawdown: number, priceReturn: number): {
  overlayStatus: PredictionSnapshotStatus | null;
  reviewFlag: boolean;
} {
  const worst = Math.min(maxDrawdown, priceReturn);
  if (worst <= DECAY_UNDER_REVIEW_DRAWDOWN) {
    return { overlayStatus: "UNDER_REVIEW", reviewFlag: true };
  }
  if (worst <= DECAY_REVIEW_DRAWDOWN) {
    return { overlayStatus: null, reviewFlag: true };
  }
  return { overlayStatus: null, reviewFlag: false };
}

/**
 * Display-layer overlay. The stored snapshot status and investorFacing bits do not change.
 */
export function displayedSnapshot(
  snapshot: Pick<PredictionSnapshot, "status" | "investorFacing" | "analogueSet">,
  marks: readonly Pick<PredictionDecayMark, "overlayStatus">[],
): DisplayedSnapshot {
  const underReview = marks.some((mark) => mark.overlayStatus === "UNDER_REVIEW");
  const status: PredictionSnapshotStatus = underReview ? "UNDER_REVIEW" : snapshot.status;
  const investorFacing = snapshot.investorFacing && !underReview && status === "VALID";
  return {
    status,
    investorFacing,
    overlayApplied: underReview,
    unavailableReason: investorFacing ? null : unavailableReason({ ...snapshot, status }),
  };
}

export function dueDecayMarks(input: {
  snapshot: Pick<PredictionSnapshot, "predictionAsOf" | "horizon">;
  asOf: Date;
  existing: readonly { markKind: DecayMarkKind; asOf: Date }[];
}): { kind: DecayMarkKind; asOf: Date }[] {
  const asOfKey = utcDateKey(input.asOf);
  const seen = new Set(input.existing.map((row) => `${row.markKind}|${utcDateKey(row.asOf)}`));
  const schedule = decayScheduleForSnapshot(input.snapshot);
  const due: { kind: DecayMarkKind; asOf: Date }[] = [];
  for (const weekly of schedule.weekly) {
    if (utcDateKey(weekly) > asOfKey) continue;
    const key = `WEEKLY_MTM|${utcDateKey(weekly)}`;
    if (!seen.has(key)) due.push({ kind: "WEEKLY_MTM", asOf: weekly });
  }
  if (utcDateKey(schedule.final) <= asOfKey) {
    const key = `HORIZON_FINAL|${utcDateKey(schedule.final)}`;
    if (!seen.has(key)) due.push({ kind: "HORIZON_FINAL", asOf: schedule.final });
  }
  return due;
}
