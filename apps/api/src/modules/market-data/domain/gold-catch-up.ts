import { XAUUSD_OANDA_PROFILE } from "../../platform/calendar/instrument-profile.js";

/**
 * When gold's stored 1m series is far enough behind that the regular tick cannot catch it up.
 *
 * `XAU_CANDLE_COLLECTION` only ever fetches the last 45 minutes, so after the host has slept or the scheduler has been down for longer
 * than that, the missed bars stay missing until `XAU_GAP_HEAL` fills them, and that runs once an hour at :07 IST. Measured over the
 * nine mornings to 2026-10-29 the scheduler came back between 03:00 and 04:10 UTC and the first heal ran at :37 UTC, so for up to an
 * hour the ICT snapshots, and the bot's first decisions of the day, were computed over a series with the whole overnight hole in it.
 *
 * Asked at every collection tick before collecting: if at least `GOLD_CATCH_UP_AFTER_OPEN_MINUTES` of the instrument's open time have
 * passed since the newest stored bar closed, run the heal now instead of waiting for :07. Only open minutes count, so the weekend
 * close and the daily New York break never trigger it, and an ordinary tick (the newest bar a few minutes old) never does.
 *
 * Gold's profile has no holiday calendar, so a closure it does not know about looks like a feed that is behind, and stays "due" on every
 * tick for as long as it lasts. The heal is several minutes of provider calls that run before the tick's own collection, so it is
 * attempted at most once per `GOLD_CATCH_UP_COOLDOWN_MINUTES`, which is also how often the regular heal runs.
 */
export const GOLD_CATCH_UP_AFTER_OPEN_MINUTES = 50;

/** The shortest time between two catch-up attempts by one process. */
export const GOLD_CATCH_UP_COOLDOWN_MINUTES = 60;

const MINUTE_MS = 60_000;

/**
 * The minutes between two instants that the market was open, counted one minute at a time and stopped at `cap`, because the caller only
 * needs to know whether the cap is reached. The cap also bounds the work across a weekend, which counts nothing.
 */
export function openMinutesBetween(
  from: Date,
  to: Date,
  cap: number,
  isOpen: (minute: Date) => boolean = (minute) => XAUUSD_OANDA_PROFILE.isSessionActive(minute),
): number {
  let open = 0;
  for (let t = from.getTime(); t < to.getTime() && open < cap; t += MINUTE_MS) {
    if (isOpen(new Date(t))) open += 1;
  }
  return open;
}

/** Whether enough time has passed since the last catch-up attempt (null: none yet in this process) to make another. */
export function goldCatchUpCooldownElapsed(lastAttemptAt: Date | null, now: Date): boolean {
  return lastAttemptAt === null || now.getTime() - lastAttemptAt.getTime() >= GOLD_CATCH_UP_COOLDOWN_MINUTES * MINUTE_MS;
}

/** True when the newest stored 1m bar is at least `GOLD_CATCH_UP_AFTER_OPEN_MINUTES` of open time behind `now`, or there is no bar at all and the market is open. */
export function goldCatchUpDue(
  input: { readonly newestBarCloseTime: Date | null; readonly now: Date },
  isOpen: (minute: Date) => boolean = (minute) => XAUUSD_OANDA_PROFILE.isSessionActive(minute),
): boolean {
  if (input.newestBarCloseTime === null) return isOpen(input.now);
  return openMinutesBetween(input.newestBarCloseTime, input.now, GOLD_CATCH_UP_AFTER_OPEN_MINUTES, isOpen) >= GOLD_CATCH_UP_AFTER_OPEN_MINUTES;
}
