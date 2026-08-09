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
});
