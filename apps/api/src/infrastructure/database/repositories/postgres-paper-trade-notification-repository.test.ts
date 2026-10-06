import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresPaperTradeNotificationRepository } from "./postgres-paper-trade-notification-repository.js";

describe("PostgresPaperTradeNotificationRepository", () => {
  it("projects committed automated OPENED events without writing in the bot path", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        event_id: "event-1",
        paper_trade_id: "trade-1",
        source: "AUTONOMOUS_AGENT",
        account_id: "account-1",
        account_name: "Default Paper Account",
        instrument_symbol: "NIFTY50",
        timeframe: "5m",
        side: "LONG",
        quantity: "65",
        entry_price: "123.45",
        stop_loss: "98.76",
        target_price: "160.00",
        occurred_at: new Date("2026-08-12T08:00:00.000Z"),
        option_strike: "25000",
        option_expiry: new Date("2026-08-13T10:00:00.000Z"),
        option_type: "CE",
        underlying_symbol: "NIFTY50",
      }],
    }));
    const repository = new PostgresPaperTradeNotificationRepository(
      { query } as unknown as DatabaseQueryable,
    );

    await expect(repository.listRecentAutomatedOpens(500)).resolves.toEqual([{
      eventId: "event-1",
      paperTradeId: "trade-1",
      source: "AUTONOMOUS_AGENT",
      accountId: "account-1",
      accountName: "Default Paper Account",
      instrumentSymbol: "NIFTY50",
      timeframe: "5m",
      side: "LONG",
      quantity: 65,
      entryPrice: 123.45,
      stopLoss: 98.76,
      targetPrice: 160,
      occurredAt: "2026-08-12T08:00:00.000Z",
      optionStrike: 25000,
      optionExpiry: "2026-08-13T10:00:00.000Z",
      optionType: "CE",
      underlyingSymbol: "NIFTY50",
    }]);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("event.event_type = 'OPENED'");
    expect(sql).toContain("account.name = 'AutoBot'");
    expect(sql).toContain("AI Autonomous Execution");
    expect(sql).toContain("Atomic volatility straddle");
    expect(parameters).toEqual([100]);
  });

  it("keeps non-option contract fields null", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [{
          event_id: "event-2", paper_trade_id: "trade-2", source: "PAPER_BOT",
          account_id: "account-2", account_name: "AutoBot", instrument_symbol: "NIFTY50", timeframe: null,
          side: "SHORT", quantity: 1, entry_price: 25000, stop_loss: 25100,
          target_price: 24800, occurred_at: "2026-08-12T08:01:00.000Z",
          option_strike: null, option_expiry: null, option_type: null,
          underlying_symbol: null,
        }],
      })),
    } as unknown as DatabaseQueryable;

    const [notification] = await new PostgresPaperTradeNotificationRepository(database)
      .listRecentAutomatedOpens();
    expect(notification).toMatchObject({
      optionStrike: null,
      optionExpiry: null,
      optionType: null,
      underlyingSymbol: null,
    });
  });
});
