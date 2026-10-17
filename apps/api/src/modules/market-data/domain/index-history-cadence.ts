/**
 * Which index timeframes INDICES_INTRADAY asks Fyers history for on a given minute.
 *
 * The job runs every minute and used to fetch 1m, 5m and 15m for both indices each time: six history requests a
 * minute, about 2,250 over a session. Measured on 2026-10-15, the endpoint hands back the bar that is still forming
 * (a bar's first copy lands about 0.3 minutes after it opens), and a later fetch completes it. A 5m bar therefore
 * changes at its own boundary, not every minute, and 780 of the 5m calls and 840 of the 15m calls found nothing new.
 *
 * What a consumer reads is the completed bar, and that only appears once a fetch lands after the bar's close. So a
 * 5m bar is fetched on the minute it closes and the one after (the second is the retry for a bar published a moment
 * late); 15m likewise. 1m changes every minute and is always fetched. NSE's session starts at 09:15, so 5m and 15m
 * bars close on minutes divisible by 5 and 15 respectively.
 *
 * What changes: the *forming* 5m and 15m bar in the table now moves at its boundary instead of every minute. The
 * completed bar, which the bot, the shadow pass and the indicators read, arrives no later than before.
 */
const BAR_MINUTES: Readonly<Record<string, number>> = { "1m": 1, "5m": 5, "15m": 15 };

/** How many consecutive minutes from a bar's close are fetched: the close itself and one retry. */
export const HISTORY_FETCH_MINUTES_AFTER_CLOSE = 2;

/** The minute of the hour in IST. IST is UTC+5:30, so this is the UTC minute shifted by 30. */
export function istMinuteOfHour(at: Date): number {
  return new Date(at.getTime() + 330 * 60_000).getUTCMinutes();
}

export function shouldFetchIndexHistory(timeframe: string, istMinute: number): boolean {
  const barMinutes = BAR_MINUTES[timeframe];
  // An unknown timeframe keeps today's behaviour: fetched every time.
  if (barMinutes === undefined || barMinutes === 1) return true;
  return istMinute % barMinutes < HISTORY_FETCH_MINUTES_AFTER_CLOSE;
}
