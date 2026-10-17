import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresFyersRequestLedger } from "./postgres-fyers-request-ledger.js";

describe("PostgresFyersRequestLedger", () => {
  it("skips recording when count is zero or negative", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    await ledger.recordRequests("2026-10-17", "quotes", 0);
    await ledger.recordRequests("2026-10-17", "quotes", -5);

    expect(query).not.toHaveBeenCalled();
  });

  it("inserts or updates request count on conflict", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    await ledger.recordRequests("2026-10-17", "quotes", 15);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO fyers_daily_request_ledger");
    expect(sql).toContain("ON CONFLICT (date_key, endpoint)");
    expect(sql).toContain("request_count = fyers_daily_request_ledger.request_count + EXCLUDED.request_count");
    expect(params).toEqual(["2026-10-17", "quotes", 15]);
  });

  it("records batch of endpoint counts filtering out zero counts", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    await ledger.recordBatch("2026-10-17", {
      quotes: 10,
      history: 0,
      depth: 5,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO fyers_daily_request_ledger"),
      ["2026-10-17", "quotes", 10],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO fyers_daily_request_ledger"),
      ["2026-10-17", "depth", 5],
    );
  });

  it("returns daily total summed across all endpoints", async () => {
    const query = vi.fn(async () => ({ rows: [{ total: "1420" }] }));
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    const total = await ledger.getDailyTotal("2026-10-17");
    expect(total).toBe(1420);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("SELECT COALESCE(SUM(request_count), 0)::text as total");
    expect(sql).toContain("WHERE date_key = $1");
    expect(params).toEqual(["2026-10-17"]);
  });

  it("returns 0 if no records exist for the date", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    const total = await ledger.getDailyTotal("2026-10-17");
    expect(total).toBe(0);
  });

  it("attaches to global counter and persists batched counts", async () => {
    const { fyersRequestCounter, reportFyersRequestCounts } = await import(
      "../../../modules/market-data/domain/fyers-request-counter.js"
    );
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as DatabasePool;
    const ledger = new PostgresFyersRequestLedger(pool);

    ledger.attachToGlobalCounter();
    fyersRequestCounter.record("quotes:collector", 12);
    reportFyersRequestCounts(fyersRequestCounter, vi.fn(), "test-script");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO fyers_daily_request_ledger");
    expect(params[1]).toBe("quotes:collector");
    expect(params[2]).toBe(12);
  });
});

