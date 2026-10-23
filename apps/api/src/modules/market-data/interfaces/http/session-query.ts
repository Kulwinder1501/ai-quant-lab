/**
 * Query-string rules shared by the routes that read one IST trading day of an index future (the depth history and
 * heatmap, the volume profile). Pure, so they are tested without a server.
 */

/** Index futures the app knows the contract of. Whether data is stored for one is a separate question. */
export const INDEX_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;
export type IndexUnderlying = (typeof INDEX_UNDERLYINGS)[number];

/** How far back a session drop-down looks. The tables start in September 2026; older days are asked for by date. */
export const SESSION_LOOKBACK_DAYS = 60;

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar date (`YYYY-MM-DD`) of an instant. India has no daylight saving. */
export function istDate(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A calendar date shifted by whole days, computed in UTC so no timezone or daylight-saving rule can move it. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/**
 * Validates `underlying` and `date`.
 *
 * `date` is an IST calendar date (`2026-10-22`), the exchange's trading day. It is a date, not an instant, so the
 * "no bare date" rule of an instant parameter does not apply: the route reads it in IST and says so. A date that is not a
 * real calendar day, or is after today in IST, is refused.
 */
export function parseUnderlyingAndDate(
  input: { underlying: string | undefined; date: string | undefined },
  now: Date,
): { ok: true; underlying: IndexUnderlying; date: string | null } | { ok: false; error: string } {
  const underlying = (input.underlying?.trim() || "BANKNIFTY").toUpperCase();
  if (!(INDEX_UNDERLYINGS as readonly string[]).includes(underlying)) {
    return { ok: false, error: `\`underlying\` must be one of ${INDEX_UNDERLYINGS.join(", ")}.` };
  }
  const rawDate = input.date?.trim();
  if (!rawDate) return { ok: true, underlying: underlying as IndexUnderlying, date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || addDays(rawDate, 0) !== rawDate) {
    return { ok: false, error: "`date` must be a real calendar date, YYYY-MM-DD (IST trading day)." };
  }
  if (rawDate > istDate(now)) {
    return { ok: false, error: "`date` is in the future." };
  }
  return { ok: true, underlying: underlying as IndexUnderlying, date: rawDate };
}

/** A whole-number choice from a fixed list, or the default when absent. Text that merely starts with a number is refused. */
export function parseChoice<T extends number>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const text = raw?.trim();
  if (!text) return { ok: true, value: fallback };
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !(allowed as readonly number[]).includes(parsed)) {
    return { ok: false, error: `\`${name}\` must be one of ${allowed.join(", ")}.` };
  }
  return { ok: true, value: parsed as T };
}
