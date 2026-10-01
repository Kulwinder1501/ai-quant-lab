/**
 * Whether XAU/USD is trading, in UTC, for a single weekly window rather than a daily one.
 *
 * `trading-session.ts`'s `resolveTradingSession` looks exchange-agnostic but is not directly
 * reusable here: it resolves one IST calendar date into an intraday open/close pair
 * (`opensAtIstMinute`/`closesAtIstMinute`, both bounded to a single day), and its weekend rule
 * closes whole IST calendar dates. Gold trades continuously from Sunday evening to Friday
 * evening UTC -- one open, one close, spanning the week -- which that shape cannot express
 * without a parallel per-day special case for the two boundary days. A small UTC-native
 * function is simpler and more honest than forcing a weekly window through a daily resolver.
 *
 * Window: opens Sunday 22:00 UTC, closes Friday 22:00 UTC. Saturday is always closed, and so is
 * the rest of Sunday before the open. No holiday calendar: unlike NSE, gold has no exchange
 * holidays to track here -- Twelve Data simply stops updating when the underlying venues are
 * shut, so a request during a real closure returns stale data rather than an error.
 */
import { XAUUSD_OANDA_PROFILE, getNewYorkParts } from "./instrument-profile.js";

export function isXauSessionOpen(now: Date): boolean {
  return XAUUSD_OANDA_PROFILE.isSessionActive(now);
}

/**
 * True inside the last `minutesBeforeClose` minutes of the week's session.
 *
 * A signal raised this close to the weekly close has no session left to manage before the
 * weekend gap -- the direct-fill analogue of `isAtOrAfterSessionEntryCutoff`, which exists for
 * exactly the same reason on the NSE bots' daily close.
 */
export function isNearXauWeeklyClose(now: Date, minutesBeforeClose: number): boolean {
  const ny = getNewYorkParts(now);
  if (ny.dayOfWeek !== 5) return false; // Friday in New York
  const minutesSinceMidnight = ny.hour * 60 + ny.minute;
  const closeMinute = 17 * 60; // 17:00 NY time
  return minutesSinceMidnight >= closeMinute - minutesBeforeClose && minutesSinceMidnight < closeMinute;
}
