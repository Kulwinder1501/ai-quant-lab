import {
  promotionBlocker,
  type ClassifiedDivergence,
} from "../../modules/autonomous-v2/domain/differential-testing.js";
import type { DivergenceForReview } from "../../infrastructure/database/repositories/postgres-differential-observations.js";

/**
 * Turns a stored divergence into the row a reviewer reads, including whether it blocks promotion.
 *
 * ## The blocking column comes from the gate, not from a second opinion
 *
 * `promotionBlocker` is the function P13 itself calls. Re-deriving "is this blocking" here -- even as
 * something as obvious as `kind === "UNKNOWN"` -- would create two definitions that agree today and
 * drift the first time a rule changes, and the drift would show up as a reviewer working through a
 * list that no longer matches what the gate refuses. One implementation, same as `comparableAction`.
 *
 * Separate from the CLI because that file runs `main()` on import, so a test importing it would start
 * a real run against the database.
 */

export interface DivergenceReviewRow {
  readonly comparisonKey: string;
  /** What each side did, and why. The reason is what a classification is actually chosen from. */
  readonly legacy: string;
  readonly v2: string;
  readonly snapshot: string;
  readonly classification: string;
  /** The gate's own words, or null when this row no longer blocks. */
  readonly blocker: string | null;
}

/**
 * The classification as a reviewer needs to see it, which is not simply the kind.
 *
 * A `BUG` with no resolution and a `BUG` with one are the same kind and opposite situations -- §6
 * makes only the first a blocker -- so the resolution is part of the label rather than a detail
 * behind it. An unclassified row says so explicitly instead of showing an empty cell, because "not
 * yet looked at" and "looked at and could not classify" are different states and both appear here.
 */
export function describeClassification(row: DivergenceForReview): string {
  if (row.classification === null) return "(unclassified)";
  const { evidence } = row.classification;
  const suffix = ` r${row.classification.revision} by ${row.classification.classifiedBy}`;
  if (evidence.kind === "BUG") {
    return `BUG ${evidence.resolutionRef === null ? "UNRESOLVED" : `resolved:${evidence.resolutionRef}`}${suffix}`;
  }
  return `${evidence.kind}${suffix}`;
}

export function reviewRow(row: DivergenceForReview): DivergenceReviewRow {
  /*
   * An unclassified row is presented to the gate as UNKNOWN, which is exactly how the shadow pass
   * treats it. That keeps the blocker text identical to what P13 would print rather than
   * approximating it.
   */
  const divergence: ClassifiedDivergence = {
    observation: {
      comparisonKey: row.comparisonKey,
      legacySnapshotRef: row.contextSnapshotId,
      v2SnapshotRef: row.contextSnapshotId,
      legacyOutcome: row.legacyAction,
      v2Outcome: row.v2Action,
    },
    evidence: row.classification?.evidence ?? { kind: "UNKNOWN" },
  };

  return {
    comparisonKey: row.comparisonKey,
    legacy: row.legacyReason === null ? row.legacyAction : `${row.legacyAction} (${row.legacyReason})`,
    v2: row.v2Reason === null ? row.v2Action : `${row.v2Action} (${row.v2Reason})`,
    snapshot: row.contextSnapshotId.slice(0, 12),
    classification: describeClassification(row),
    blocker: promotionBlocker(divergence),
  };
}

/**
 * The `classify:divergence` invocation for a row, ready to copy.
 *
 * The comparison key is the one thing a reviewer cannot obtain from anywhere else, and typing an
 * instant by hand is how the wrong bar gets classified. `--kind` and its evidence are left as
 * placeholders on purpose: the tool must not suggest a classification, for the same reason the
 * classifier does not infer one.
 */
export function classifyCommandFor(row: DivergenceForReview): string {
  return "npm run classify:divergence -- "
    + `--comparison-key='${row.comparisonKey}' --producer='${row.producerId}' `
    + "--kind=<KIND> <EVIDENCE FLAGS> --by='<you>' --rationale='<why>'";
}
