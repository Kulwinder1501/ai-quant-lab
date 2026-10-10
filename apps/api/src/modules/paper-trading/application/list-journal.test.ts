import { describe, expect, it, vi } from "vitest";
import { ListJournalTrades } from "./list-journal.js";
import { InvalidTradeHistoryQueryError } from "./list-paper-trade-history.js";
import type { JournalQueryRepository, JournalTradeRecord } from "../domain/journal.js";

function record(overrides: Partial<JournalTradeRecord> = {}): JournalTradeRecord {
  return {
    simulatedOnly: true,
    id: "trade-1",
    accountId: "account-1",
    accountName: "AutoBot-IctBankNifty5m",
    instrumentId: "instrument-1",
    instrumentSymbol: "BANKNIFTY",
    instrumentName: "Bank Nifty",
    timeframe: "5m",
    tradeIdeaId: "idea-1",
    strategyName: "ICT Structure",
    side: "LONG",
    status: "CLOSED",
    quantity: 25,
    entryPrice: 54500,
    stopLoss: 54300,
    targetPrice: 54900,
    openedAt: new Date("2026-10-01T04:00:00Z"),
    closedAt: new Date("2026-10-01T05:00:00Z"),
    exitPrice: 54900,
    exitReason: "TARGET",
    realizedPnl: 10000,
    returnPercent: 0.73,
    rewardMultiple: 2,
    holdingMinutes: 60,
    fees: 50,
    slippage: 0,
    notes: "",
    optionType: null,
    optionStrike: null,
    underlyingSymbol: null,
    reasoning: ["LONG ICT Structure entry: swept sell-side liquidity then shifted structure up."],
    evidenceStrategy: "ict-structure-v1",
    review: {
      outcome: "WIN",
      realizedR: 2,
      maximumAdverseExcursionR: 0.2,
      maximumFavourableExcursionR: 2.1,
      candlesObserved: 12,
      observedTimeframe: "5m",
      observations: ["Closed TARGET at 54900.00 for 2R (10000.00 on 5000.00 at risk)."],
      proposedResearchTags: [],
    },
    ...overrides,
  };
}

function fakeRepository(records: JournalTradeRecord[] = [record()]): JournalQueryRepository & {
  listCalls: unknown[];
} {
  const listCalls: unknown[] = [];
  return {
    listCalls,
    async list(input) {
      listCalls.push(input);
      return records;
    },
    async listAccountNames() {
      return [{ id: "account-1", name: "AutoBot-IctBankNifty5m" }];
    },
  };
}

describe("ListJournalTrades", () => {
  it("returns records with reasoning and review intact, plus accounts and a summary", async () => {
    const repository = fakeRepository();
    const result = await new ListJournalTrades(repository).execute({ accountId: "account-1" });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.reasoning).toEqual([
      "LONG ICT Structure entry: swept sell-side liquidity then shifted structure up.",
    ]);
    expect(result.records[0]!.review?.outcome).toBe("WIN");
    expect(result.accounts).toEqual([{ id: "account-1", name: "AutoBot-IctBankNifty5m" }]);
    expect(result.summary.winningTradeCount).toBe(1);
  });

  it("passes the validated, +1 limit through to the repository (for truncation detection)", async () => {
    const repository = fakeRepository();
    await new ListJournalTrades(repository).execute({ limit: 10 });
    expect(repository.listCalls[0]).toMatchObject({ limit: 11 });
  });

  it("rejects a limit outside the allowed range", async () => {
    const repository = fakeRepository();
    await expect(new ListJournalTrades(repository).execute({ limit: 0 })).rejects.toThrow(InvalidTradeHistoryQueryError);
    await expect(new ListJournalTrades(repository).execute({ limit: 10_000 })).rejects.toThrow(InvalidTradeHistoryQueryError);
  });

  it("rejects openedFrom after openedTo", async () => {
    const repository = fakeRepository();
    await expect(
      new ListJournalTrades(repository).execute({
        openedFrom: new Date("2026-10-05T00:00:00Z"),
        openedTo: new Date("2026-10-01T00:00:00Z"),
      }),
    ).rejects.toThrow(/openedFrom must not be later/);
  });

  it("rejects an unknown side, status, exitReason, or outcome the same way Trade History does", async () => {
    const repository = fakeRepository();
    await expect(
      new ListJournalTrades(repository).execute({ side: "SIDEWAYS" as never }),
    ).rejects.toThrow(InvalidTradeHistoryQueryError);
  });

  it("marks the page truncated when the repository returns more than the requested limit", async () => {
    const repository = fakeRepository([record({ id: "a" }), record({ id: "b" }), record({ id: "c" })]);
    const result = await new ListJournalTrades(repository).execute({ limit: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
