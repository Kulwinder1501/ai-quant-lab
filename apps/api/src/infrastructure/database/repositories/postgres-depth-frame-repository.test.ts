import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresDepthFrameRepository } from "./postgres-depth-frame-repository.js";

/** What node-postgres hands back: BIGINT and NUMERIC (and their arrays) as strings, dates as Date. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    provider_symbol: "NSE:BANKNIFTY26OCTFUT",
    sequence_no: "37342",
    exchange_feed_time: "1792737462",
    received_at: new Date("2026-10-23T09:27:42.933Z"),
    is_snapshot: false,
    levels_stored: 2,
    levels_available: 50,
    bid_price: ["54200.0000", "54199.8000"],
    bid_qty: ["60", "30"],
    bid_orders: [2, 1],
    ask_price: ["54228.2000", "54228.4000"],
    ask_qty: ["60", "30"],
    ask_orders: [1, 1],
    total_buy_qty: "28080",
    total_sell_qty: "60270",
    gap_before: 0,
    is_duplicate: false,
    capture_session_id: "session-1",
    ...overrides,
  };
}

describe("PostgresDepthFrameRepository.latestFrame", () => {
  it("looks up one exact symbol, newest first, as an indexed walk", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "nse:banknifty26octfut" });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("provider_symbol = $1");
    expect(sql).toMatch(/ORDER BY received_at DESC, sequence_no DESC\s+LIMIT 1/);
    // Exact match, upper-cased: a prefix scan would not use the (provider_symbol, received_at) index.
    expect(sql).not.toMatch(/LIKE/i);
    expect(values).toEqual(["NSE:BANKNIFTY26OCTFUT", null]);
  });

  it("bounds the read at an instant when asked", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const asOf = new Date("2026-10-22T04:30:00.000Z");
    await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "NSE:BANKNIFTY26OCTFUT", asOf });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("received_at <= $2::timestamptz");
    expect(values[1]).toBe(asOf);
  });

  it("returns null when nothing is stored", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "NSE:NIFTY26OCTFUT" })).toBeNull();
  });

  it("converts the driver's string arrays and BIGINTs to numbers without altering values", async () => {
    const query = vi.fn(async () => ({ rows: [storedRow()] }));
    const frame = await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "NSE:BANKNIFTY26OCTFUT" });

    expect(frame).toMatchObject({
      providerSymbol: "NSE:BANKNIFTY26OCTFUT",
      sequenceNo: 37_342,
      exchangeFeedTime: 1_792_737_462,
      isSnapshot: false,
      levelsStored: 2,
      levelsAvailable: 50,
      bidPrice: [54_200, 54_199.8],
      bidQty: [60, 30],
      bidOrders: [2, 1],
      askPrice: [54_228.2, 54_228.4],
      askQty: [60, 30],
      totalBuyQty: 28_080,
      totalSellQty: 60_270,
      gapBefore: 0,
      isDuplicate: false,
      captureSessionId: "session-1",
    });
    expect(frame!.receivedAt).toEqual(new Date("2026-10-23T09:27:42.933Z"));
  });

  it("keeps a missing total or sequence as null, never zero", async () => {
    const query = vi.fn(async () => ({
      rows: [storedRow({ sequence_no: null, exchange_feed_time: null, total_buy_qty: null, total_sell_qty: null, capture_session_id: null })],
    }));
    const frame = await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "NSE:BANKNIFTY26OCTFUT" });
    expect(frame).toMatchObject({
      sequenceNo: null, exchangeFeedTime: null, totalBuyQty: null, totalSellQty: null, captureSessionId: null,
    });
  });

  it("does not read the unreliable regression flag at all", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresDepthFrameRepository({ query } as unknown as DatabasePool)
      .latestFrame({ providerSymbol: "NSE:BANKNIFTY26OCTFUT" });
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).not.toContain("is_regression");
  });
});
