import type { DatabasePool } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { DailyTradeCapReachedError, PostgresPaperTradeRepository } from "./postgres-paper-trade-repository.js";

/**
 * The daily cap is enforced inside the transaction that opens every trade, so these assert on the
 * statement sequence: that the count is scoped and ordered correctly, that a blocked open reaches
 * no INSERT, and that a blocked second leg rolls the first one back.
 */

const OPENED_AT = new Date("2026-08-17T10:00:00.000Z"); // 15:30 IST on 2026-08-17

function accountRow(dailyTradeCap: number | null | undefined) {
  const row: Record<string, unknown> = {
    id: "account-1", name: "AutoBot-Classic", opening_balance: "1000000",
    currency: "INR", is_active: true,
  };
  if (dailyTradeCap !== undefined) row.daily_trade_cap = dailyTradeCap;
  return row;
}

const IDEA_ROW = {
  id: "idea-1", instrument_id: "instrument-1", side: "LONG",
  entry_price: "100", stop_loss: "90", target_price: "110",
  expires_at: null, lot_size: 75,
};

function harness(options: {
  dailyTradeCap: number | null | undefined;
  openedToday?: number;
  /** Rows the idea lookup returns. Empty stops the flow just after the cap gate. */
  ideaRows?: unknown[];
}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push(text.replace(/\s+/g, " ").trim());
      parameters.push(values ?? []);
      // Checked before the generic paper_trades branch: the count query also reads that table.
      if (text.includes("COUNT(*) AS opened_today")) {
        return { rows: [{ opened_today: String(options.openedToday ?? 0) }] };
      }
      if (text.includes("FROM paper_accounts") && text.includes("FOR UPDATE")) {
        return { rows: [accountRow(options.dailyTradeCap)] };
      }
      if (text.includes("FROM trade_ideas") && text.includes("FOR UPDATE")) {
        return { rows: options.ideaRows ?? [] };
      }
      if (text.includes("AS available_capital")) return { rows: [{ available_capital: "1000000" }] };
      if (text.includes("INSERT INTO paper_trades")) return { rows: [{ id: "trade-1" }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
  return { statements, parameters, client, repository: new PostgresPaperTradeRepository(database) };
}

const OPEN_INPUT = {
  accountId: "account-1",
  tradeIdeaId: "idea-1",
  fillPrice: 100,
  quantity: 75,
  openedAt: OPENED_AT,
  entryFees: 20,
  entrySlippage: 0,
  notes: "cap test",
};

describe("daily trade cap at the open boundary", () => {
  it("does not count anything when the account has no cap", async () => {
    const { statements, repository } = harness({ dailyTradeCap: null });

    await expect(repository.openFromTradeIdea(OPEN_INPUT)).rejects.toThrow(/Trade idea was not found/);

    // Uncapped must cost nothing: no count query is issued at all.
    expect(statements.some((statement) => statement.includes("COUNT(*) AS opened_today"))).toBe(false);
  });

  // An account row from before the column existed reads as undefined, and must behave as uncapped
  // rather than as a cap of zero, which would halt trading on deploy.
  it("treats a missing column as uncapped", async () => {
    const { statements, repository } = harness({ dailyTradeCap: undefined });

    await expect(repository.openFromTradeIdea(OPEN_INPUT)).rejects.toThrow(/Trade idea was not found/);

    expect(statements.some((statement) => statement.includes("COUNT(*) AS opened_today"))).toBe(false);
  });

  it("counts within the IST trading day, scoped to the account", async () => {
    const { statements, parameters, repository } = harness({ dailyTradeCap: 60, openedToday: 20 });

    await expect(repository.openFromTradeIdea(OPEN_INPUT)).rejects.toThrow(/Trade idea was not found/);

    const index = statements.findIndex((statement) => statement.includes("COUNT(*) AS opened_today"));
    expect(index).toBeGreaterThan(-1);
    // Half-open range on opened_at, so the index on (account_id, opened_at) can serve it.
    expect(statements[index]).toContain("opened_at >= $2");
    expect(statements[index]).toContain("opened_at < $3");
    const [accountId, start, end] = parameters[index]!;
    expect(accountId).toBe("account-1");
    // 2026-08-17 15:30 IST sits in the IST day starting 2026-08-16T18:30Z.
    expect((start as Date).toISOString()).toBe("2026-08-16T18:30:00.000Z");
    expect((end as Date).toISOString()).toBe("2026-08-17T18:30:00.000Z");
  });

  it("counts after locking the account, so concurrent opens cannot both pass", async () => {
    const { statements, repository } = harness({ dailyTradeCap: 60, openedToday: 1 });

    await expect(repository.openFromTradeIdea(OPEN_INPUT)).rejects.toThrow(/Trade idea was not found/);

    const lockIndex = statements.findIndex((s) => s.includes("FROM paper_accounts") && s.includes("FOR UPDATE"));
    const countIndex = statements.findIndex((s) => s.includes("COUNT(*) AS opened_today"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(lockIndex);
  });

  it("rejects and rolls back once the cap is reached, without inserting", async () => {
    const { statements, repository } = harness({ dailyTradeCap: 21, openedToday: 21, ideaRows: [IDEA_ROW] });

    await expect(repository.openFromTradeIdea(OPEN_INPUT))
      .rejects.toThrow(DailyTradeCapReachedError);

    expect(statements.some((statement) => statement.startsWith("INSERT INTO paper_trades"))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("names the account, the count, and the day in the refusal", async () => {
    const { repository } = harness({ dailyTradeCap: 21, openedToday: 21, ideaRows: [IDEA_ROW] });

    await expect(repository.openFromTradeIdea(OPEN_INPUT))
      .rejects.toThrow(/AutoBot-Classic has opened 21 trade\(s\) on 2026-08-17, reaching its daily cap of 21/);
  });

  it("rolls a structure back whole when its second leg would cross the cap", async () => {
    // Cap 1 with nothing opened: leg one passes at a count of 0, and leg two sees the transaction's
    // own uncommitted insert. A straddle must be both legs or neither.
    let openedToday = 0;
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text.replace(/\s+/g, " ").trim());
        if (text.includes("COUNT(*) AS opened_today")) return { rows: [{ opened_today: String(openedToday) }] };
        if (text.includes("FROM paper_accounts") && text.includes("FOR UPDATE")) {
          return { rows: [accountRow(1)] };
        }
        if (text.includes("FROM trade_ideas") && text.includes("FOR UPDATE")) return { rows: [IDEA_ROW] };
        if (text.includes("AS available_capital")) return { rows: [{ available_capital: "1000000" }] };
        if (text.includes("INSERT INTO paper_trades")) {
          openedToday += 1; // the leg the second cap check must see
          return { rows: [{ id: "trade-1" }] };
        }
        if (text.includes("UPDATE trade_ideas SET status = 'ACCEPTED'")) return { rows: [{ id: "idea-1" }] };
        if (text.includes("FROM paper_trades")) {
          return { rows: [{
            id: "trade-1", account_id: "account-1", trade_idea_id: "idea-1",
            instrument_id: "instrument-1", timeframe: "5m", side: "LONG", status: "OPEN",
            quantity: "75", entry_price: "100", stop_loss: "90", target_price: "110",
            exit_price: null, opened_at: OPENED_AT, closed_at: null, exit_reason: null,
            realized_pnl: null, fees: "20", slippage: "0", notes: "cap test",
            excluded_from_evidence: false,
          }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const repository = new PostgresPaperTradeRepository(database);

    await expect(repository.openPairFromTradeIdeas([
      { ...OPEN_INPUT, tradeIdeaId: "idea-1" },
      { ...OPEN_INPUT, tradeIdeaId: "idea-2" },
    ])).rejects.toThrow(DailyTradeCapReachedError);

    expect(statements.filter((statement) => statement.startsWith("INSERT INTO paper_trades"))).toHaveLength(1);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});
