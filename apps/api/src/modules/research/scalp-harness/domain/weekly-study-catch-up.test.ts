import { describe, expect, it } from "vitest";
import { isTransientDatabaseConnectionError, isWeeklyStudyOverdue } from "./weekly-study-catch-up.js";

const days = (n: number): number => n * 24 * 60 * 60_000;
const STALE_AFTER = days(8);

describe("isWeeklyStudyOverdue", () => {
  it("is overdue when the study has never been declared", () => {
    expect(isWeeklyStudyOverdue({
      lastDeclaredAt: null, now: new Date("2026-09-15T00:00:00.000Z"), staleAfterMs: STALE_AFTER,
    })).toBe(true);
  });

  it("is not overdue the day after a normal weekly run", () => {
    expect(isWeeklyStudyOverdue({
      lastDeclaredAt: new Date("2026-09-13T01:45:00.000Z"),
      now: new Date("2026-09-14T09:00:00.000Z"),
      staleAfterMs: STALE_AFTER,
    })).toBe(false);
  });

  it("is overdue once three Saturdays have genuinely been missed", () => {
    // Exactly the measured incident: last declared 2026-08-25, checked on 2026-09-15.
    expect(isWeeklyStudyOverdue({
      lastDeclaredAt: new Date("2026-08-25T15:45:00.000Z"),
      now: new Date("2026-09-15T10:00:00.000Z"),
      staleAfterMs: STALE_AFTER,
    })).toBe(true);
  });

  it("does not fire exactly at the boundary", () => {
    const lastDeclaredAt = new Date("2026-09-01T00:00:00.000Z");
    const now = new Date(lastDeclaredAt.getTime() + STALE_AFTER);
    expect(isWeeklyStudyOverdue({ lastDeclaredAt, now, staleAfterMs: STALE_AFTER })).toBe(false);
    expect(isWeeklyStudyOverdue({
      lastDeclaredAt, now: new Date(now.getTime() + 1), staleAfterMs: STALE_AFTER,
    })).toBe(true);
  });

  it("refuses a non-positive staleness threshold instead of running on every startup", () => {
    expect(() => isWeeklyStudyOverdue({
      lastDeclaredAt: null, now: new Date(), staleAfterMs: 0,
    })).toThrow(/staleAfterMs must be positive/);
  });
});

describe("isTransientDatabaseConnectionError", () => {
  it("treats connection-refused, cannot-connect-now, timeout, and reset as transient", () => {
    expect(isTransientDatabaseConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientDatabaseConnectionError({ code: "57P03" })).toBe(true);
    expect(isTransientDatabaseConnectionError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientDatabaseConnectionError({ code: "ECONNRESET" })).toBe(true);
  });

  it("does not treat a real query/schema defect as transient", () => {
    expect(isTransientDatabaseConnectionError({ code: "42P01" })).toBe(false); // undefined_table
    expect(isTransientDatabaseConnectionError(new Error("syntax error"))).toBe(false);
  });

  it("handles non-object and codeless errors without throwing", () => {
    expect(isTransientDatabaseConnectionError(null)).toBe(false);
    expect(isTransientDatabaseConnectionError(undefined)).toBe(false);
    expect(isTransientDatabaseConnectionError("a plain string")).toBe(false);
    expect(isTransientDatabaseConnectionError({})).toBe(false);
  });
});
