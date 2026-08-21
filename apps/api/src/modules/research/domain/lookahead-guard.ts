/**
 * The runtime anti-lookahead guard: refuses a claim whose evidence postdates the decision.
 *
 * ## Why this exists as a guard rather than a test
 *
 * This codebase has already shipped a look-ahead bug and paid for it retroactively. Migration
 * `048-purge-look-ahead-smc-snapshots` deletes `indicator_snapshots` for three SMC indicators that
 * were reading future bars, and the property is now held only by unit tests on those specific
 * indicators. That is the wrong shape of defence: it protects the six functions someone remembered
 * to test, and nothing else. Every model, feature and settlement written between the bug landing and
 * the bug being noticed was graded against contaminated evidence, and no assertion anywhere would
 * have objected.
 *
 * A guard that any producer can call converts that class of bug from "discovered months later by
 * reading a suspicious accuracy number" into "throws on the first row". It is cheap, and it is the
 * only item in the microstructure programme that pays for itself even if every signal in that
 * programme turns out to be noise.
 *
 * ## What is actually being compared, and what is deliberately not
 *
 * One thing only: **the instant the evidence was knowable** against **the instant the decision was
 * stamped**. `featureAsOf <= decidedAt` must hold.
 *
 * Equality is legal and common: a feature computed from the bar that just closed, used to decide on
 * that close, has `featureAsOf === decidedAt`. Only strictly-later evidence is a violation.
 *
 * This is **not** the `FEATURE_LAG` check, and must not be conflated with it. That check asks
 * whether a feature is suspiciously predictive of a persistent target, which is mis-premised for
 * persistent targets and produces false alarms on them. This asks a question with no statistical
 * content at all: did we use a number that did not exist yet. There is no legitimate reason for the
 * answer to be yes, so there is no threshold to tune and no target for which it should be relaxed.
 *
 * ## The failure mode this file is most careful about
 *
 * An invalid `Date` compares `false` against everything, including in `>`. So a `NaN` timestamp
 * sails through a naive `if (featureAsOf > decidedAt) throw` and is recorded as compliant — the
 * guard reports success precisely when it knows least. Both timestamps are therefore validated
 * before they are compared, and an unparseable one is its own violation rather than a pass.
 */

export const LOOKAHEAD_VIOLATION = "LOOKAHEAD_VIOLATION" as const;

/** Why a claim was refused. Distinguished so a bad clock is not reported as a leak. */
export type LookaheadViolationReason =
  /** Evidence postdates the decision: a genuine leak. */
  | "EVIDENCE_FROM_FUTURE"
  /** A timestamp was missing or unparseable, so point-in-time-ness could not be established. */
  | "UNVERIFIABLE_TIMESTAMP";

export interface PointInTimeClaim {
  /** What is being asserted, quoted back in the error so a failure names its own source. */
  readonly label: string;
  /** The latest instant any input to this feature was knowable. */
  readonly featureAsOf: Date;
  /** The instant the decision using it was stamped. */
  readonly decidedAt: Date;
}

export interface LookaheadViolation {
  readonly code: typeof LOOKAHEAD_VIOLATION;
  readonly reason: LookaheadViolationReason;
  readonly label: string;
  readonly featureAsOf: string | null;
  readonly decidedAt: string | null;
  /** How far the evidence postdates the decision. Null when a timestamp was unverifiable. */
  readonly aheadByMs: number | null;
  readonly message: string;
}

export class LookaheadViolationError extends Error {
  readonly code = LOOKAHEAD_VIOLATION;
  readonly violation: LookaheadViolation;

  constructor(violation: LookaheadViolation) {
    super(violation.message);
    this.name = "LookaheadViolationError";
    this.violation = violation;
  }
}

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function iso(value: unknown): string | null {
  return isUsableDate(value) ? value.toISOString() : null;
}

/**
 * Inspects one claim and returns the violation, or null when it is point-in-time.
 *
 * Non-throwing, so a bulk audit over thousands of rows can collect every failure instead of
 * stopping at the first. `assertPointInTime` is the throwing form.
 */
export function inspectPointInTime(claim: PointInTimeClaim): LookaheadViolation | null {
  const label = claim.label?.trim() === "" ? "(unlabelled claim)" : claim.label;

  if (!isUsableDate(claim.featureAsOf) || !isUsableDate(claim.decidedAt)) {
    return {
      code: LOOKAHEAD_VIOLATION,
      reason: "UNVERIFIABLE_TIMESTAMP",
      label,
      featureAsOf: iso(claim.featureAsOf),
      decidedAt: iso(claim.decidedAt),
      aheadByMs: null,
      message:
        `${label}: point-in-time-ness could not be established because a timestamp was missing or `
        + `unparseable (featureAsOf=${iso(claim.featureAsOf) ?? "invalid"}, `
        + `decidedAt=${iso(claim.decidedAt) ?? "invalid"}). An unverifiable claim is refused rather `
        + "than assumed compliant: an invalid Date compares false against every bound, so accepting "
        + "it would report success exactly where nothing is known.",
    };
  }

  const aheadByMs = claim.featureAsOf.getTime() - claim.decidedAt.getTime();
  if (aheadByMs <= 0) return null;

  return {
    code: LOOKAHEAD_VIOLATION,
    reason: "EVIDENCE_FROM_FUTURE",
    label,
    featureAsOf: claim.featureAsOf.toISOString(),
    decidedAt: claim.decidedAt.toISOString(),
    aheadByMs,
    message:
      `${label}: feature evidence is dated ${claim.featureAsOf.toISOString()}, which is ${aheadByMs}ms `
      + `after the decision at ${claim.decidedAt.toISOString()}. The decision used information that `
      + "did not exist when it was made.",
  };
}

/** Throws `LookaheadViolationError` unless the claim is point-in-time. */
export function assertPointInTime(claim: PointInTimeClaim): void {
  const violation = inspectPointInTime(claim);
  if (violation) throw new LookaheadViolationError(violation);
}

/** Every violation across a batch, in input order. Empty means the batch is clean. */
export function findLookaheadViolations(
  claims: readonly PointInTimeClaim[],
): LookaheadViolation[] {
  const violations: LookaheadViolation[] = [];
  for (const claim of claims) {
    const violation = inspectPointInTime(claim);
    if (violation) violations.push(violation);
  }
  return violations;
}
