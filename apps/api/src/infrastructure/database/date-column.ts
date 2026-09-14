/**
 * Conversions for `DATE` columns, which carry a calendar day and no instant.
 *
 * node-pg is asymmetric about these, and both directions corrupt the value if
 * left to their defaults:
 *
 * * Writing, it serialises a Date using the *host process's* local timezone, so a
 *   UTC-midnight Date becomes the previous calendar day on any host west of UTC.
 * * Reading, it returns a Date anchored at *local* midnight. Calling
 *   `toISOString()` on that shifts the day backwards anywhere east of UTC — in
 *   IST (UTC+5:30) the session `2026-07-30` reads back as `2026-07-29`.
 *
 * The second direction is the subtler one: it produces a plausible date that is
 * simply the wrong session, so a flow print silently reports yesterday's figures
 * under the day before. Everything crossing this boundary goes through these two
 * functions so a session's identity is independent of where the process runs.
 */

/** Bind a session date as an ISO `YYYY-MM-DD` string rather than as a Date. */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Re-anchor a `DATE` value from node-pg to UTC midnight.
 *
 * The local components are the intended calendar day, because that is how the
 * driver built the Date from the column's `YYYY-MM-DD` text.
 */
export function fromDateColumn(value: unknown): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  if (typeof value === "string") {
    // Already a plain calendar day when the driver is configured to pass it through.
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (match) {
      return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    }
  }
  throw new Error(`Expected a DATE column value, received ${String(value)}.`);
}
