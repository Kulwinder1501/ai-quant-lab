import type { ExpiryKind } from "./option-chain.js";

/**
 * Which option contracts an underlying actually lists, as the provider reports them.
 *
 * This exists because a plausible expiry is indistinguishable from a real one. Two paper
 * trades were booked against a BANKNIFTY 2026-08-04 expiry; BANKNIFTY has no weekly series
 * at all, so the contract never traded. Both priced cleanly against a 1-day tenor when the
 * real contract had 22 days, and every number downstream — premium, greeks, return — looked
 * correct the whole way through.
 *
 * `resolveWeeklyExpiryWeekday` closed the door on *deriving* a phantom expiry from a guessed
 * weekday. It cannot help when a caller supplies an expiry directly, which is how these two
 * got in. The provider's own list is the only authority available, so it is stored and
 * checked against.
 */
export interface ListedExpiry {
  /** 10:00 UTC = 15:30 IST, the session close on which an NSE contract settles. */
  expiryDate: Date;
  expiryKind: ExpiryKind;
  /**
   * The provider's own handle for this expiry, needed to request its book.
   *
   * One chain request returns one expiry's quotes; asking for a different one means passing the
   * provider's token back. Optional because it is provider detail: nothing in the domain reads it,
   * and a calendar assembled from storage will not have it.
   */
  providerExpiryToken?: string | null;
}

export interface OptionExpiryCalendar {
  underlyingSymbol: string;
  provider: string;
  /** Receipt time. Expiry lists carry no exchange clock. */
  observedAt: Date;
  expiries: ListedExpiry[];
}

export class OptionExpiryCalendarError extends Error {}

export type ListedExpiryResolution =
  | { usable: true; expiryDate: Date; expiryKind: ExpiryKind }
  | { usable: false; reason: "NO_CALENDAR" | "EXPIRY_NOT_LISTED"; explanation: string };

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Whether a requested expiry is a contract the provider lists.
 *
 * Matched on calendar date, not instant: the provider publishes dates, and a caller may
 * legitimately supply any time on the expiry day.
 *
 * Refuses when no calendar has been collected. That is deliberate and costs an operator one
 * collection run, where guessing costs every number computed from the position. It is the
 * same trade `resolveWeeklyExpiryWeekday` already makes.
 *
 * A stale calendar can only refuse a contract that is genuinely listed — expiries are added,
 * never withdrawn — so the failure direction is safe, and the refusal names the observation
 * date so the fix is obvious. There is no separate staleness gate, because a second
 * threshold would add a failure mode without evidence for where to put it.
 */
export function resolveListedExpiry(
  calendar: OptionExpiryCalendar | null,
  requestedExpiry: Date,
  underlyingSymbol: string,
): ListedExpiryResolution {
  if (calendar === null || calendar.expiries.length === 0) {
    return {
      usable: false,
      reason: "NO_CALENDAR",
      explanation:
        `No option-expiry calendar has been collected for ${underlyingSymbol}, so the requested `
        + "expiry cannot be checked against the contracts that actually list. Run "
        + `\`npm run data:collect:option-chain -- --underlyings=${underlyingSymbol}\` first.`,
    };
  }
  if (Number.isNaN(requestedExpiry.getTime())) {
    return {
      usable: false,
      reason: "EXPIRY_NOT_LISTED",
      explanation: `The requested ${underlyingSymbol} expiry is not a valid date.`,
    };
  }

  const requestedKey = dateKey(requestedExpiry);
  const match = calendar.expiries.find((entry) => dateKey(entry.expiryDate) === requestedKey);
  if (match) {
    return { usable: true, expiryDate: match.expiryDate, expiryKind: match.expiryKind };
  }

  const listed = [...calendar.expiries]
    .sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime())
    .slice(0, 4)
    .map((entry) => `${dateKey(entry.expiryDate)} (${entry.expiryKind})`)
    .join(", ");
  const weeklies = calendar.expiries.filter((entry) => entry.expiryKind === "WEEKLY").length;
  // Named explicitly: "no weekly series" is the fact that made the phantom contract look
  // reasonable, and a bare list of monthly dates does not say it out loud.
  const seriesNote = weeklies === 0
    ? ` ${underlyingSymbol} lists no weekly series — every expiry it carries is monthly.`
    : "";

  return {
    usable: false,
    reason: "EXPIRY_NOT_LISTED",
    explanation:
      `${underlyingSymbol} does not list an expiry on ${requestedKey}, so pricing it would `
      + `describe a contract that does not trade.${seriesNote} Nearest listed: ${listed}. `
      + `(Calendar observed ${calendar.observedAt.toISOString()}; re-collect if a newer `
      + "contract has since been listed.)",
  };
}

export type ExpirySelection =
  | { usable: true; expiryDate: Date; expiryKind: ExpiryKind; daysToExpiry: number }
  | { usable: false; reason: "NO_CALENDAR" | "NO_EXPIRY_FAR_ENOUGH_OUT"; explanation: string };

/**
 * Picks the nearest listed expiry at least `minimumDaysToExpiry` away.
 *
 * An automated caller has to choose a contract rather than be handed one, and choosing is
 * where a phantom gets in: a weekday rule invents 11 Aug for BANKNIFTY, which lists nothing
 * before 25 Aug. So the choice is made *from* the provider's list -- every candidate is
 * therefore a contract that trades, and the underlying's series structure needs no special
 * casing. A monthly-only underlying simply has a more distant nearest expiry.
 *
 * The floor exists because the entry gate refuses sub-1-DTE contracts at anything short of
 * top confidence, and because an expiry-day option is nearly all gamma: a stop placed in
 * premium space stops describing the underlying move it was derived from. Selecting a
 * contract the gate would then refuse is a slower way of getting the same answer.
 */
export function selectNearestListedExpiry(
  calendar: OptionExpiryCalendar | null,
  now: Date,
  minimumDaysToExpiry: number,
): ExpirySelection {
  if (calendar === null || calendar.expiries.length === 0) {
    return {
      usable: false,
      reason: "NO_CALENDAR",
      explanation:
        `No option-expiry calendar has been collected for ${calendar?.underlyingSymbol ?? "this underlying"}, `
        + "so no contract can be chosen. Collect the option chain first.",
    };
  }

  const earliestAcceptable = now.getTime() + minimumDaysToExpiry * 24 * 60 * 60 * 1000;
  const candidates = [...calendar.expiries]
    .filter((entry) => !Number.isNaN(entry.expiryDate.getTime()) && entry.expiryDate.getTime() >= earliestAcceptable)
    .sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime());

  const chosen = candidates[0];
  if (!chosen) {
    const listed = [...calendar.expiries]
      .sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime())
      .slice(0, 4)
      .map((entry) => `${dateKey(entry.expiryDate)} (${entry.expiryKind})`)
      .join(", ");
    return {
      usable: false,
      reason: "NO_EXPIRY_FAR_ENOUGH_OUT",
      explanation:
        `${calendar.underlyingSymbol} lists no expiry at least ${minimumDaysToExpiry} day(s) out. `
        + `Nearest listed: ${listed}. (Calendar observed ${calendar.observedAt.toISOString()}.)`,
    };
  }

  return {
    usable: true,
    expiryDate: chosen.expiryDate,
    expiryKind: chosen.expiryKind,
    daysToExpiry: (chosen.expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  };
}

/** Rejects a calendar that cannot be a real observation, before it reaches the table. */
export function assertCalendarStorable(calendar: OptionExpiryCalendar): void {
  if (!calendar.underlyingSymbol.trim()) {
    throw new OptionExpiryCalendarError("An expiry calendar needs an underlying symbol.");
  }
  if (Number.isNaN(calendar.observedAt.getTime())) {
    throw new OptionExpiryCalendarError("An expiry calendar needs a valid observation time.");
  }
  if (calendar.expiries.length === 0) {
    throw new OptionExpiryCalendarError(
      `The ${calendar.underlyingSymbol} expiry list came back empty. Every listed underlying has `
      + "at least one expiry, so an empty list is a provider fault rather than an observation — "
      + "and storing it would later read as 'this underlying lists nothing', which would refuse "
      + "every real contract.",
    );
  }
  const seen = new Set<string>();
  for (const entry of calendar.expiries) {
    if (Number.isNaN(entry.expiryDate.getTime())) {
      throw new OptionExpiryCalendarError(
        `A ${calendar.underlyingSymbol} listed expiry has an invalid date.`,
      );
    }
    const key = dateKey(entry.expiryDate);
    if (seen.has(key)) {
      throw new OptionExpiryCalendarError(
        `The ${calendar.underlyingSymbol} expiry list repeats ${key}, so one of the two entries `
        + "carries the wrong series flag.",
      );
    }
    seen.add(key);
  }
}
