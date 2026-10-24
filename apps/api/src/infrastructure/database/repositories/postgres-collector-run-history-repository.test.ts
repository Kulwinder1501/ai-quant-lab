import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { findFyersRequestLedger, findScheduledJobRuns } from "./postgres-collector-run-history-repository.js";

describe("findScheduledJobRuns", () => {
  it("reads one job type over the IST dates inclusive, oldest first, through the claim index columns", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await findScheduledJobRuns({ query } as unknown as DatabaseQueryable, { jobType: "OPTION_CHAIN", fromDate: "2026-10-01", toDate: "2026-10-23" });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("FROM scheduled_job_runs");
    expect(sql).toContain("job_type = $1");
    // The end date is inclusive: the window runs to the start of the next IST day.
    expect(sql).toMatch(/\(\$3::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Kolkata'/);
    expect(sql).toMatch(/ORDER BY scheduled_for ASC/);
    expect(values).toEqual(["OPTION_CHAIN", "2026-10-01", "2026-10-23"]);
  });

  it("returns the failure text only for a failed run", async () => {
    const scheduledFor = new Date("2026-10-16T05:41:00.000Z");
    const query = vi.fn(async () => ({
      rows: [
        { scheduled_for: scheduledFor, status: "FAILED", error_details: "HTTP 429, code -360" },
        { scheduled_for: scheduledFor, status: "COMPLETED", error_details: "stale text that must not be returned" },
      ],
    }));
    const runs = await findScheduledJobRuns({ query } as unknown as DatabaseQueryable, { jobType: "OPTION_CHAIN", fromDate: "2026-10-16", toDate: "2026-10-16" });
    expect(runs).toEqual([
      { scheduledFor, status: "FAILED", errorDetails: "HTTP 429, code -360" },
      { scheduledFor, status: "COMPLETED", errorDetails: null },
    ]);
  });
});

describe("findFyersRequestLedger", () => {
  it("reads the per-day, per-endpoint counts over the date keys inclusive", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await findFyersRequestLedger({ query } as unknown as DatabaseQueryable, { fromDate: "2026-10-17", toDate: "2026-10-23" });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("FROM fyers_daily_request_ledger");
    expect(sql).toContain("date_key >= $1 AND date_key <= $2");
    expect(values).toEqual(["2026-10-17", "2026-10-23"]);
  });

  it("converts the counts to numbers, whichever form the driver returns", async () => {
    const query = vi.fn(async () => ({
      rows: [
        { date_key: "2026-10-20", endpoint: "quotes:api", request_count: 4794 },
        { date_key: "2026-10-20", endpoint: "history", request_count: "553" },
      ],
    }));
    expect(await findFyersRequestLedger({ query } as unknown as DatabaseQueryable, { fromDate: "2026-10-20", toDate: "2026-10-20" })).toEqual([
      { dateKey: "2026-10-20", endpoint: "quotes:api", requestCount: 4794 },
      { dateKey: "2026-10-20", endpoint: "history", requestCount: 553 },
    ]);
  });
});
