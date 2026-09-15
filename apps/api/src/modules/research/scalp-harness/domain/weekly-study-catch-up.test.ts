import { describe, expect, it } from "vitest";
import { isWeeklyStudyOverdue } from "./weekly-study-catch-up.js";

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
