/**
 * The `asOf` query parameter shared by the routes that can read the past: a full ISO-8601 instant with an offset.
 *
 * A bare date would be read in the server's timezone by `Date.parse`, the class of off-by-a-day error this codebase has hit before,
 * so it is refused rather than guessed at. Pure, so the rules are tested without a server.
 */

/** How far ahead of the server clock an `asOf` may be before it is refused as a mistake, not a past instant. */
const AS_OF_FUTURE_TOLERANCE_MS = 5_000;

export type AsOfParse = { ok: true; value: Date | null } | { ok: false; error: string };

export function parseAsOf(raw: string | undefined, now: Date): AsOfParse {
  const text = raw?.trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return { ok: false, error: "`asOf` must be an ISO-8601 instant with an offset, e.g. 2026-10-22T04:30:00Z." };
  }
  const asOf = new Date(text);
  if (Number.isNaN(asOf.getTime())) return { ok: false, error: "`asOf` is not a real date and time." };
  if (asOf.getTime() > now.getTime() + AS_OF_FUTURE_TOLERANCE_MS) return { ok: false, error: "`asOf` is in the future." };
  return { ok: true, value: asOf };
}
