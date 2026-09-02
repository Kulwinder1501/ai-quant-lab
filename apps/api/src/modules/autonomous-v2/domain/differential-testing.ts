/**
 * Brain V2.2 P13: V1 / V2 differential testing, and the promotion gate it feeds.
 *
 * §6 states the requirement: *"Before V1 is retired, both systems must run against identical sealed
 * snapshots. Every divergence must be formally classified — not just explained with a free-text
 * reason."* This module is that classification, and the rule that `UNKNOWN` blocks promotion.
 *
 * It is the mechanism that makes retiring V1 a verified change rather than a hopeful one. Without it,
 * a cutover rests on the absence of noticed problems, which is not the same as the absence of
 * problems.
 *
 * ## Why the classification is a discriminated union and not a string plus a note
 *
 * "Formally classified, not just explained with a free-text reason" is a design instruction, and a
 * `{ classification, reason }` pair does not satisfy it: `reason` accepts anything, so every
 * divergence can be waved through by whoever is looking at it on the day. Each classification here
 * carries the *specific* evidence its own meaning requires — a policy difference must name both
 * policy versions, a risk difference must name the rule that fired, a bug must carry its resolution.
 *
 * The effect is that mislabelling costs more than labelling honestly. To dismiss an unexplained
 * divergence as `POLICY_DIFFERENCE` you must produce two policy versions that differ, and if you
 * have those, it probably *is* a policy difference.
 *
 * ## `UNKNOWN` is the default, deliberately
 *
 * Nothing in this module infers a classification. An observation arrives unclassified and stays a
 * promotion blocker until a human attaches evidence. That direction matters: a classifier that
 * guessed would let a real defect be absorbed by the nearest plausible category, and `BUG` and
 * `UNKNOWN` are precisely the two categories a guess would avoid.
 *
 * Same shape as `classifyTick` and `parseDeferralReason` elsewhere in this system: the residual
 * bucket is reachable and blocking, so silence cannot pass for a clean result.
 *
 * ## A comparison across two different snapshots is not a comparison
 *
 * The load-bearing invariant, and the reason both refs are recorded rather than one. §6 requires
 * *identical* sealed snapshots; if the two sides read different ones, any difference in their answers
 * is uninterpretable — it could be the architecture, or it could be that they saw different worlds.
 * `assertComparable` refuses that case outright rather than letting it be classified as a
 * `DATA_DIFFERENCE`, which is the category it would otherwise be quietly filed under.
 */

export type DivergenceClassification =
  | "EXPECTED_ARCHITECTURAL_CHANGE"
  | "DATA_DIFFERENCE"
  | "POLICY_DIFFERENCE"
  | "RISK_DIFFERENCE"
  | "EXECUTION_DIFFERENCE"
  | "BUG"
  | "UNKNOWN";

/** One decision point where the two systems were asked the same question. */
export interface DifferentialObservation {
  /** What was compared: enough to find it again, e.g. `NIFTY50@2026-09-02T09:20:00Z`. */
  readonly comparisonKey: string;
  /** The sealed snapshot V1 read. */
  readonly legacySnapshotRef: string;
  /** The sealed snapshot V2.2 read. Must equal the above; see `assertComparable`. */
  readonly v2SnapshotRef: string;
  /** Each side's answer, canonicalised by the caller so equality is meaningful. */
  readonly legacyOutcome: string;
  readonly v2Outcome: string;
}

/**
 * The evidence each classification requires. Not interchangeable, and not free text.
 *
 * `BUG` carries `resolutionRef` rather than a description, because §6's promotion rule turns on
 * whether it is *resolved*, not on whether it is understood.
 */
export type DivergenceEvidence =
  | {
    readonly kind: "EXPECTED_ARCHITECTURAL_CHANGE";
    /** The invariant or named design decision that predicted this difference, e.g. "I18". */
    readonly designDecision: string;
  }
  | {
    readonly kind: "DATA_DIFFERENCE";
    /** Both boundaries, named. "V2 is more correct" is a claim; these are the facts behind it. */
    readonly legacyBoundary: string;
    readonly v2Boundary: string;
  }
  | {
    readonly kind: "POLICY_DIFFERENCE";
    readonly legacyPolicyVersion: string;
    readonly v2PolicyVersion: string;
  }
  | {
    readonly kind: "RISK_DIFFERENCE";
    /** The rule V2's risk engine applied that V1 did not. */
    readonly riskRule: string;
  }
  | {
    readonly kind: "EXECUTION_DIFFERENCE";
    /** The execution condition V2 checked, e.g. "stale option chain". */
    readonly executionCondition: string;
  }
  | {
    readonly kind: "BUG";
    /** Null until fixed. A `BUG` with no resolution blocks promotion. */
    readonly resolutionRef: string | null;
  }
  | { readonly kind: "UNKNOWN" };

export interface ClassifiedDivergence {
  readonly observation: DifferentialObservation;
  readonly evidence: DivergenceEvidence;
}

export class DifferentialTestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DifferentialTestingError";
  }
}

/**
 * Refuses an observation whose two sides did not read the same sealed snapshot.
 *
 * Throws rather than returning a verdict, because a non-comparison has no place in the divergence
 * population at all -- admitting it and marking it somehow would put an uninterpretable row next to
 * interpretable ones, and the promotion gate counts rows.
 */
export function assertComparable(observation: DifferentialObservation): void {
  if (observation.legacySnapshotRef.trim() === "" || observation.v2SnapshotRef.trim() === "") {
    throw new DifferentialTestingError(
      `${observation.comparisonKey}: both sides must cite the sealed snapshot they read. An `
      + "unrecorded snapshot cannot be shown to be the same one.",
    );
  }
  if (observation.legacySnapshotRef !== observation.v2SnapshotRef) {
    throw new DifferentialTestingError(
      `${observation.comparisonKey}: the two systems read different snapshots `
      + `(${observation.legacySnapshotRef} vs ${observation.v2SnapshotRef}), so any difference in `
      + "their answers is uninterpretable -- it could be the architecture, or it could be that they "
      + "saw different worlds. §6 requires identical sealed snapshots. This is not a DATA_DIFFERENCE.",
    );
  }
}

/** True when the two systems answered identically. Agreement is not a divergence. */
export function agrees(observation: DifferentialObservation): boolean {
  assertComparable(observation);
  return observation.legacyOutcome === observation.v2Outcome;
}

/**
 * The classification an observation carries, which is `UNKNOWN` until evidence is attached.
 *
 * Nothing here infers. See the module note: a guessing classifier would absorb real defects into the
 * nearest plausible category, and the two categories a guess would avoid are exactly the two that
 * block promotion.
 */
export function classificationOf(divergence: ClassifiedDivergence): DivergenceClassification {
  return divergence.evidence.kind;
}

/** Why a divergence blocks promotion, or null when it does not. */
export function promotionBlocker(divergence: ClassifiedDivergence): string | null {
  const { evidence, observation } = divergence;
  if (evidence.kind === "UNKNOWN") {
    return `${observation.comparisonKey}: UNKNOWN — V1 said ${observation.legacyOutcome}, V2 said `
      + `${observation.v2Outcome}, and nothing explains it. §6 makes this a promotion blocker until `
      + "resolved.";
  }
  if (evidence.kind === "BUG" && evidence.resolutionRef === null) {
    return `${observation.comparisonKey}: BUG with no resolution recorded. §6 requires a BUG to be `
      + "resolved before promotion, not merely identified.";
  }
  return null;
}

export interface DifferentialVerdict {
  readonly comparisons: number;
  readonly agreements: number;
  readonly divergences: number;
  readonly byClassification: Readonly<Record<DivergenceClassification, number>>;
  /** Empty means V1 may be retired on this evidence. */
  readonly blockers: readonly string[];
  readonly promotable: boolean;
}

const ALL_CLASSIFICATIONS: readonly DivergenceClassification[] = [
  "EXPECTED_ARCHITECTURAL_CHANGE",
  "DATA_DIFFERENCE",
  "POLICY_DIFFERENCE",
  "RISK_DIFFERENCE",
  "EXECUTION_DIFFERENCE",
  "BUG",
  "UNKNOWN",
];

/**
 * The P13 gate: whether the differential evidence permits retiring V1.
 *
 * Every classification is reported at zero rather than omitted, for the reason the deferral families
 * are: a category missing from a report is indistinguishable from a category that never occurred, and
 * the second is the interesting reading. `UNKNOWN: 0` is a claim worth being able to make.
 *
 * `promotable` on an empty run is **false**, and that is not an oversight. Zero comparisons is no
 * evidence, and the one thing this gate must never do is read "nothing went wrong" off a run that
 * asked nothing -- which is precisely the failure a cutover-by-absence-of-complaints would be.
 */
export function evaluateDifferentialRun(input: {
  readonly observations: readonly DifferentialObservation[];
  readonly divergences: readonly ClassifiedDivergence[];
}): DifferentialVerdict {
  for (const observation of input.observations) assertComparable(observation);
  for (const divergence of input.divergences) assertComparable(divergence.observation);

  const byClassification = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<DivergenceClassification, number>;
  for (const divergence of input.divergences) {
    byClassification[classificationOf(divergence)] += 1;
  }

  const agreements = input.observations.filter((observation) => agrees(observation)).length;
  const blockers = input.divergences
    .map((divergence) => promotionBlocker(divergence))
    .filter((blocker): blocker is string => blocker !== null);

  return {
    comparisons: input.observations.length,
    agreements,
    divergences: input.divergences.length,
    byClassification: Object.freeze(byClassification),
    blockers,
    promotable: input.observations.length > 0 && blockers.length === 0,
  };
}
