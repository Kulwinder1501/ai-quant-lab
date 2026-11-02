import { istInstant } from "../../modules/platform/calendar/trading-session.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses NSE's "12-Oct-2026 09:07" (IST, minute resolution) into an instant, or null. */
export function parseNseIndexTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month < 0) return null;
  const sessionDate = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const base = istInstant(sessionDate, hour * 60 + minute);
  return new Date(base.getTime() + Number(match[6] ?? 0) * 1000);
}
