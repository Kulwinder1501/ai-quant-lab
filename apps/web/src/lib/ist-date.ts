const istDateFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Formats an instant as the canonical YYYY-MM-DD trading date in Asia/Kolkata. */
export function formatIstDate(value: Date): string {
  const parts = new Map(istDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/** True only when a timestamp belongs to the requested Asia/Kolkata calendar date. */
export function isTimestampOnIstDate(timestamp: string | null | undefined, date: string): boolean {
  if (!timestamp) return false;
  const parsed = new Date(timestamp);
  return !Number.isNaN(parsed.getTime()) && formatIstDate(parsed) === date;
}
