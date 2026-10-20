/**
 * Whether the exchange is in a session in which a quote can change.
 *
 * Weekdays only, not on an NSE holiday, from the 09:00 pre-open to five minutes after the 15:30 close (the closing
 * prints land after the bell). Outside it a quote is the last close and a REST call for it can only return the same
 * numbers.
 *
 * Used by the API's quote reader to stop asking Fyers for quotes that cannot have changed. On 2026-10-20, a market
 * holiday, an open dashboard tab sent a quote request every 2.5 seconds per stream and the API spent 4,779 of the
 * day's 5,000 requests by mid-afternoon, with nothing new to show for any of them.
 */
export const QUOTE_SESSION_OPEN_MINUTE = 9 * 60;
export const QUOTE_SESSION_CLOSE_MINUTE = 15 * 60 + 35;

const IST_OFFSET_MINUTES = 330;

export function isQuoteSessionOpen(at: Date, holidays: ReadonlySet<string>): boolean {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const weekday = ist.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.has(ist.toISOString().slice(0, 10))) return false;
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minute >= QUOTE_SESSION_OPEN_MINUTE && minute < QUOTE_SESSION_CLOSE_MINUTE;
}
