import { describe, expect, it, vi } from "vitest";
import { PostgresStrategyMarketContextRepository } from "./postgres-strategy-market-context-repository.js";
import type { DatabasePool } from "../database.js";

describe("PostgresStrategyMarketContextRepository - Asian session dayCandles loader", () => {
  it("queries and attaches dayCandles for XAU_USD at supported timeframes", async () => {
    const mockQuery = vi.fn().mockImplementation((queryText: string) => {
      // 1. Candles query in findLatestCompleted
      if (queryText.includes("FROM candles") && queryText.includes("LIMIT 1")) {
        return Promise.resolve({
          rows: [
            {
              id: "candle-xau-1",
              instrument_id: "inst-xau",
              timeframe: "5m",
              open_time: new Date("2026-10-22T07:30:00Z"),
              close_time: new Date("2026-10-22T07:35:00Z"),
              open: "2705.00",
              high: "2712.50",
              low: "2703.00",
              close: "2706.00",
              volume: "1000",
              tick_size: "0.01",
              symbol: "XAU_USD",
            },
          ],
        });
      }

      // 2. Day candles query for Asian session
      if (queryText.includes("WHERE instrument_id = $1") && queryText.includes("open_time >= $3")) {
        return Promise.resolve({
          rows: [
            {
              id: "c-asia-1",
              instrument_id: "inst-xau",
              timeframe: "5m",
              open_time: new Date("2026-10-22T01:00:00Z"),
              close_time: new Date("2026-10-22T01:05:00Z"),
              open: "2700.00",
              high: "2710.00",
              low: "2695.00",
              close: "2702.00",
              volume: "500",
              is_complete: true,
            },
          ],
        });
      }

      // 3. Fallback for indicators, patterns, priceActionEvents, option chain, etc.
      return Promise.resolve({ rows: [] });
    });

    const mockDb = { query: mockQuery } as unknown as DatabasePool;
    const repo = new PostgresStrategyMarketContextRepository(mockDb);

    const context = await repo.findLatestCompleted({ instrumentId: "inst-xau", timeframe: "5m" });

    expect(context).not.toBeNull();
    expect(context?.candle.symbol).toBe("XAU_USD");
    expect(context?.dayCandles).toBeDefined();
    expect(context?.dayCandles).toHaveLength(1);
    expect(context?.dayCandles?.[0]?.high).toBe(2710.0);
    expect(context?.dayCandles?.[0]?.low).toBe(2695.0);
  });

  it("skips dayCandles query for non-Gold instruments (e.g. NIFTYBEES) even with tickSize 0.01", async () => {
    let dayCandlesQueried = false;

    const mockQuery = vi.fn().mockImplementation((queryText: string) => {
      if (queryText.includes("FROM candles") && queryText.includes("LIMIT 1")) {
        return Promise.resolve({
          rows: [
            {
              id: "candle-niftybees-1",
              instrument_id: "inst-niftybees",
              timeframe: "5m",
              open_time: new Date("2026-10-22T07:30:00Z"),
              close_time: new Date("2026-10-22T07:35:00Z"),
              open: "260.00",
              high: "265.00",
              low: "259.00",
              close: "261.00",
              volume: "5000",
              tick_size: "0.01",
              symbol: "NIFTYBEES",
            },
          ],
        });
      }

      if (queryText.includes("open_time >= $3") && queryText.includes("open_time <= $4")) {
        dayCandlesQueried = true;
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    });

    const mockDb = { query: mockQuery } as unknown as DatabasePool;
    const repo = new PostgresStrategyMarketContextRepository(mockDb);

    const context = await repo.findLatestCompleted({ instrumentId: "inst-niftybees", timeframe: "5m" });

    expect(context).not.toBeNull();
    expect(context?.candle.symbol).toBe("NIFTYBEES");
    expect(dayCandlesQueried).toBe(false); // Verified: loader gate prevented the query
    expect(context?.dayCandles).toBeUndefined();
  });
});
