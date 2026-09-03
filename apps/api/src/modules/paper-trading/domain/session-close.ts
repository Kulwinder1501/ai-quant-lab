/**
 * The intraday square-off: no position outlives the session that opened it.
 *
 * Measured 2026-09-03 over 383 closed paper trades. Stop exits overshot the stop by 8.9% of the
 * risk unit on the 165 stops sampled every ~4.6 seconds -- irreducible discretisation, not a
 * defect. The excess sat almost entirely in three positions that crossed a session boundary:
 *
 *   NIFTY50    opened 08-20 15:20 -> closed 08-21 09:15   overshoot 4.56R   -Rs 1,055
 *   BANKNIFTY  opened 08-20 15:20 -> closed 08-21 09:15   overshoot 1.78R   -Rs   778
 *   BANKNIFTY  opened 08-18 15:00 -> closed 08-18 15:51   overshoot 3.64R   -Rs 1,539
 *
 * The first two were carried overnight and their stops were then resolved against the next
 * morning's opening tick, which gapped 10.95 points past a 2.40-point stop. Nothing squared them
 * off: `END_OF_DAY_EXPIRATION` in the evaluator cancels untriggered PENDING orders only, and has
 * no equivalent for a filled position.
 *
 * The money at stake is small -- about 5% of the loss on that sample -- but an overnight gap is
 * unbounded, and a 5-minute scalp with a 32-bar horizon has no thesis that survives a close. This
 * bounds the exposure rather than predicting it.
 *
 * ## Why a wall clock and not a bar count
 *
 * The rule has to fire on a session boundary the strategy cannot see. A holding-period cap is a
 * different rule with a different justification (`MOMENTUM_STALL`), and it would still leave a
 * position opened at 15:20 running into the night.
 */

/** The exchange clock this rule is written against. The container runs UTC. */
const IST = "Asia/Kolkata";

/**
 * 15:15 IST, fifteen minutes before the NSE close.
 *
 * Not 15:30. A flatten needs a quoted bid to price against, and the closing window is exactly
 * where the book thins and the index feed has been observed to freeze. Fifteen minutes leaves the
 * square-off inside liquid trade while costing the tail of a session whose thesis was minutes long.
 */
export const SESSION_CLOSE_FLATTEN_IST_MINUTES = 15 * 60 + 15;

/**
 * The timeframes this applies to.
 *
 * Gated by timeframe rather than applied to every option position, following `MOMENTUM_STALL`.
 * Every paper trade in the record is 1m or 5m, so today the distinction is theoretical -- but a
 * blanket rule would silently square off a multi-day position the moment one is ever opened, and
 * that is a decision that should be made deliberately rather than inherited from this file.
 */
export const INTRADAY_FLATTEN_TIMEFRAMES: readonly string[] = ["1m", "3m", "5m", "15m"];

/**
 * Minutes since midnight on the IST wall clock.
 *
 * Read through `Intl` rather than by adding 5h30m to a UTC instant: the offset is arithmetic that
 * happens to be right for India today, and the scheduler already resolves every cron this way.
 */
export function istMinutesSinceMidnight(instant: Date): number {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Cannot read the IST wall clock from an invalid date.");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error("Could not read the IST wall clock.");
  }
  return hour * 60 + minute;
}

/** True once the IST wall clock has reached the square-off cutoff. */
export function isAtOrAfterSessionCloseCutoff(asOf: Date): boolean {
  return istMinutesSinceMidnight(asOf) >= SESSION_CLOSE_FLATTEN_IST_MINUTES;
}

/**
 * Whether this position must be squared off now.
 *
 * A null timeframe returns false. It means the position's source bar is unknown, and squaring off
 * on an unknown holding period would be a guess -- the same reasoning that makes an absent
 * `candle_feature_coverage` row mean "unknown" rather than "empty".
 */
export function shouldFlattenAtSessionClose(timeframe: string | null, asOf: Date): boolean {
  if (timeframe === null) return false;
  if (!INTRADAY_FLATTEN_TIMEFRAMES.includes(timeframe)) return false;
  return isAtOrAfterSessionCloseCutoff(asOf);
}
