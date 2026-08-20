import type { Request } from "express";

export class InvalidHttpQueryError extends Error {}

export function queryString(request: Request, key: string): string | undefined {
  const value = request.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidHttpQueryError(`${key} must be supplied once as text.`);
  }
  return value;
}

export function parseLimit(request: Request): number | undefined {
  const limitText = queryString(request, "limit");
  if (limitText === undefined) return undefined;
  if (!/^\d+$/.test(limitText.trim())) {
    throw new InvalidHttpQueryError("limit must be a whole number.");
  }
  return Number(limitText);
}

export function parseUtcTimestamp(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new InvalidHttpQueryError(`${field} must be a UTC ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new InvalidHttpQueryError(`${field} must be an ISO-8601 timestamp.`);
  }
  return parsed;
}

/** UTC half-open range occupied by one Asia/Kolkata calendar date. */
export function parseIstCalendarDateRange(value: string, field: string): { from: Date; toExclusive: Date } {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new InvalidHttpQueryError(`${field} must be a calendar date in YYYY-MM-DD format.`);
  }

  const [yearText, monthText, dayText] = trimmed.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utcCalendarDay = new Date(Date.UTC(year, month - 1, day));
  if (utcCalendarDay.toISOString().slice(0, 10) !== trimmed) {
    throw new InvalidHttpQueryError(`${field} must be a valid calendar date.`);
  }

  // IST is fixed at UTC+05:30 and has no daylight-saving transitions.
  const istOffsetMilliseconds = (5 * 60 + 30) * 60_000;
  const from = new Date(utcCalendarDay.getTime() - istOffsetMilliseconds);
  return { from, toExclusive: new Date(from.getTime() + 24 * 60 * 60_000) };
}
