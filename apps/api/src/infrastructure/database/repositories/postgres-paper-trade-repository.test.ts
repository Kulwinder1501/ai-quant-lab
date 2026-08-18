import type { DatabasePool } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { PostgresPaperTradeRepository } from "./postgres-paper-trade-repository.js";

describe("PostgresPaperTradeRepository manual option transaction", () => {
  it("rolls back the synthetic idea when opening the trade fails", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text.replace(/\s+/g, " ").trim());
        if (text.includes("INSERT INTO trade_ideas")) return { rows: [{ id: "idea-1" }] };
        if (text.includes("FROM paper_accounts")) return { rows: [] };
        return { rows: [] };
      }),
      release,
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const repository = new PostgresPaperTradeRepository(database);

    await expect(repository.openManualOption({
      accountId: "account-1",
      instrumentId: "instrument-1",
      quantity: 75,
      fillPrice: 100,
      openedAt: new Date("2026-08-09T10:00:00.000Z"),
      entryFees: 20,
      entrySlippage: 0,
      notes: "test",
      stopLossOverride: 50,
      targetPriceOverride: 200,
    })).rejects.toThrow("Paper account was not found or is inactive.");

    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((statement) => statement.startsWith("INSERT INTO trade_ideas"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back the first structure leg when the second leg cannot open", async () => {
    const statements: string[] = [];
    let accountReads = 0;
    const release = vi.fn();
    const openedAt = new Date("2026-08-09T10:00:00.000Z");
    const client = {
      query: vi.fn(async (text: string) => {
        const normalized = text.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        if (text.includes("FROM paper_accounts") && text.includes("FOR UPDATE")) {
          accountReads += 1;
          return accountReads === 1
            ? { rows: [{ id: "account-1", name: "pair", opening_balance: "100000", currency: "INR", is_active: true }] }
            : { rows: [] };
        }
        if (text.includes("FROM trade_ideas") && text.includes("FOR UPDATE")) {
          return { rows: [{
            id: "idea-1", instrument_id: "instrument-1", side: "LONG",
            entry_price: "100", stop_loss: "90", target_price: "110",
            expires_at: null, lot_size: 75,
          }] };
        }
        if (text.includes("AS available_capital")) return { rows: [{ available_capital: "100000" }] };
        if (text.includes("INSERT INTO paper_trades")) return { rows: [{ id: "trade-1" }] };
        if (text.includes("UPDATE trade_ideas SET status = 'ACCEPTED'")) return { rows: [{ id: "idea-1" }] };
        // The one-position-per-idea-per-account check. Answered before the generic paper_trades
        // branch below, which exists for the trade lookup after the insert; left to fall through it
        // would report that this account had already traded the idea.
        if (text.includes("AND trade_idea_id = $2")) return { rows: [] };
        if (text.includes("FROM paper_trades")) {
          return { rows: [{
            id: "trade-1", account_id: "account-1", trade_idea_id: "idea-1",
            instrument_id: "instrument-1", timeframe: "5m", side: "LONG", status: "OPEN",
            quantity: "75", entry_price: "100", stop_loss: "90", target_price: "110",
            opened_at: openedAt, closed_at: null, exit_price: null, exit_reason: null,
            realized_pnl: null, fees: "20", fee_breakdown: {}, slippage: "0", notes: "pair",
            option_strike: null, option_expiry: null, option_type: null,
            underlying_symbol: null, underlying_entry_price: null, entry_iv: null,
          }] };
        }
        return { rows: [] };
      }),
      release,
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const repository = new PostgresPaperTradeRepository(database);
    const input = (tradeIdeaId: string) => ({
      accountId: "account-1",
      tradeIdeaId,
      quantity: 75,
      fillPrice: 100,
      openedAt,
      entryFees: 20,
      entrySlippage: 0,
      notes: "pair",
      stopLossOverride: 90,
      targetPriceOverride: 110,
    });

    await expect(repository.openPairFromTradeIdeas([
      input("idea-ce"), input("idea-pe"),
    ])).rejects.toThrow("Paper account was not found or is inactive.");

    expect(statements.filter((statement) => statement.startsWith("INSERT INTO paper_trades"))).toHaveLength(1);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("PostgresPaperTradeRepository timing boundaries", () => {
  it("moves opened_at and stop effectiveness to the actual pending fill time", async () => {
    const filledAt = new Date("2026-08-13T05:15:00.000Z");
    const statements: Array<{ text: string; parameters: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (text: string, parameters?: unknown[]) => {
        statements.push({ text: text.replace(/\s+/g, " ").trim(), parameters });
        if (text.includes("SELECT id FROM paper_trades")) return { rows: [{ id: "trade-1" }] };
        if (text.includes("FROM paper_trades") && !text.includes("SELECT id")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(new PostgresPaperTradeRepository(database).fillPendingTrade({
      paperTradeId: "trade-1",
      fillPrice: 180,
      filledAt,
    })).rejects.toThrow("Unable to resolve filled trade.");

    const update = statements.find((statement) => statement.text.startsWith("UPDATE paper_trades"));
    expect(update?.text).toContain("opened_at = $3");
    expect(update?.text).toContain("stop_loss_effective_at = $3");
    expect(update?.parameters).toEqual(["trade-1", 180, filledAt]);
  });

  it("timestamps every stop revision", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const database = { query } as unknown as DatabasePool;

    await new PostgresPaperTradeRepository(database).updateStopLoss("trade-1", 170, "tighten");

    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toContain("stop_loss_effective_at = CURRENT_TIMESTAMP");
  });
});
