/**
 * Whether an instrument's weekly-expiry weekday has been checked against an NSE
 * contract note, or is a working guess.
 */
export type WeeklyExpirySource = "CONFIRMED" | "ASSUMED";

export interface WeeklyExpirySpecification {
  weekday: number | null;
  source: WeeklyExpirySource | null;
}

export type WeeklyExpiryResolution =
  | { usable: true; weekday: number }
  | { usable: false; reason: "NO_WEEKLY_SERIES" | "UNCONFIRMED_WEEKDAY"; explanation: string };

/**
 * Decides whether a stored weekly-expiry weekday may be used to price a contract.
 *
 * An `ASSUMED` weekday is refused. The failure mode it guards against is quiet: a
 * plausible expiry date is indistinguishable from a correct one, so an index whose real
 * weekly series expires on a different day — or does not exist at all — would be priced
 * against a contract that never traded, with correct-looking premium, theta, and greeks
 * all the way through. Refusing costs a caller one explicit expiry; being wrong costs
 * every number downstream.
 *
 * A NULL weekday means no weekly series is configured, which is the honest encoding for a
 * monthly-only underlying and is also refused.
 */
export function resolveWeeklyExpiryWeekday(
  specification: WeeklyExpirySpecification,
  instrumentSymbol: string,
): WeeklyExpiryResolution {
  if (specification.weekday === null || specification.source === null) {
    return {
      usable: false,
      reason: "NO_WEEKLY_SERIES",
      explanation:
        `${instrumentSymbol} has no weekly expiry weekday configured, so one cannot be derived. `
        + "Supply an explicit expiry, or set instruments.weekly_expiry_weekday once its real "
        + "expiry day is known.",
    };
  }
  if (specification.source === "ASSUMED") {
    return {
      usable: false,
      reason: "UNCONFIRMED_WEEKDAY",
      explanation:
        `${instrumentSymbol}'s weekly expiry weekday (${specification.weekday}) is recorded as `
        + "ASSUMED rather than CONFIRMED, so it must not be used to price a contract. Verify it "
        + "against the current NSE contract note and set weekly_expiry_source = 'CONFIRMED', or "
        + "supply an explicit expiry.",
    };
  }
  return { usable: true, weekday: specification.weekday };
}
