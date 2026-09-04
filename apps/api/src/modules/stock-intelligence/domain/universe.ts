/**
 * Point-in-time eligibility. An instrument is only in the historical universe when a
 * membership row covering `asOf` was itself knowable at `asOf`.
 *
 * The M01 seed is a **current roster snapshot**. It is not a reconstructed Nifty 50 /
 * Next 50 membership archive. Until listing dates and historical index memberships are
 * sourced, `isEligibleAt` will refuse dates before the seed's `available_at`. That is
 * the survivorship guard working, not a bug.
 */
export const stockIntelligenceUniverses = ["NIFTY50", "NIFTYNXT50", "INDEX_CONTEXT"] as const;
export type StockIntelligenceUniverse = (typeof stockIntelligenceUniverses)[number];

export interface UniverseMembership {
  readonly instrumentId: string;
  readonly universe: StockIntelligenceUniverse;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly availableAt: Date;
  /**
   * Honest limitation stamped on every seeded row. `current_roster_snapshot` means
   * we know the name was on the roster when we seeded, not that it was a member at
   * every date between `effectiveFrom` and `asOf`.
   */
  readonly provenance: "current_roster_snapshot" | "historical_archive" | "manual_correction";
}

export interface InstrumentExistence {
  readonly instrumentId: string;
  readonly listedFrom: Date | null;
  readonly listedTo: Date | null;
  readonly availableAt: Date;
}

export type EligibilityDenial =
  | "NO_MEMBERSHIP"
  | "MEMBERSHIP_NOT_YET_EFFECTIVE"
  | "MEMBERSHIP_ENDED"
  | "MEMBERSHIP_NOT_YET_AVAILABLE"
  | "NOT_YET_LISTED"
  | "DELISTED"
  | "EXISTENCE_UNKNOWN";

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: EligibilityDenial | "ELIGIBLE";
  readonly membership: UniverseMembership | null;
}

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Membership covers `asOf` only when the row was knowable then. A membership
 * back-dated with `available_at` after `asOf` is look-ahead and is refused.
 */
export function membershipCoversAsOf(membership: UniverseMembership, asOf: Date): EligibilityDenial | null {
  if (!isUsableDate(asOf) || !isUsableDate(membership.availableAt) || !isUsableDate(membership.effectiveFrom)) {
    return "MEMBERSHIP_NOT_YET_AVAILABLE";
  }
  if (membership.availableAt.getTime() > asOf.getTime()) return "MEMBERSHIP_NOT_YET_AVAILABLE";
  if (membership.effectiveFrom.getTime() > asOf.getTime()) return "MEMBERSHIP_NOT_YET_EFFECTIVE";
  if (membership.effectiveTo !== null) {
    if (!isUsableDate(membership.effectiveTo)) return "MEMBERSHIP_ENDED";
    if (membership.effectiveTo.getTime() <= asOf.getTime()) return "MEMBERSHIP_ENDED";
  }
  return null;
}

export function existenceCoversAsOf(existence: InstrumentExistence | null, asOf: Date): EligibilityDenial | null {
  if (existence === null) return "EXISTENCE_UNKNOWN";
  if (!isUsableDate(asOf) || !isUsableDate(existence.availableAt)) return "EXISTENCE_UNKNOWN";
  if (existence.availableAt.getTime() > asOf.getTime()) return "EXISTENCE_UNKNOWN";
  if (existence.listedFrom === null) return "EXISTENCE_UNKNOWN";
  if (existence.listedFrom.getTime() > asOf.getTime()) return "NOT_YET_LISTED";
  if (existence.listedTo !== null) {
    if (!isUsableDate(existence.listedTo)) return "DELISTED";
    if (existence.listedTo.getTime() <= asOf.getTime()) return "DELISTED";
  }
  return null;
}

/**
 * Universe membership is required. Listing existence is required when a row exists;
 * a missing existence row is `EXISTENCE_UNKNOWN` and is not eligible for historical
 * replay. Live predictions on the current roster still need an existence row before
 * Gate 7 — seeding one with `listed_from = null` keeps that refusal honest.
 */
export function isEligibleAt(input: {
  asOf: Date;
  memberships: readonly UniverseMembership[];
  existence: InstrumentExistence | null;
  universe?: StockIntelligenceUniverse;
}): EligibilityDecision {
  const covering = input.memberships.filter((membership) => {
    if (input.universe && membership.universe !== input.universe) return false;
    return membershipCoversAsOf(membership, input.asOf) === null;
  });

  if (covering.length === 0) {
    const sameUniverse = input.memberships.filter((membership) =>
      input.universe ? membership.universe === input.universe : true,
    );
    const firstDenial = sameUniverse.length === 0
      ? "NO_MEMBERSHIP"
      : membershipCoversAsOf(sameUniverse[0]!, input.asOf) ?? "NO_MEMBERSHIP";
    return { eligible: false, reason: firstDenial, membership: null };
  }

  const existenceDenial = existenceCoversAsOf(input.existence, input.asOf);
  if (existenceDenial) {
    return { eligible: false, reason: existenceDenial, membership: covering[0]! };
  }

  return { eligible: true, reason: "ELIGIBLE", membership: covering[0]! };
}
