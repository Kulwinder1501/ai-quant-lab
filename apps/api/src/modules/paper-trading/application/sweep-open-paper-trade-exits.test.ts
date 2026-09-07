import { describe, expect, it, vi } from "vitest";
import { SweepOpenPaperTradeExits } from "./sweep-open-paper-trade-exits.js";
import type { EvaluateOpenPaperTrades } from "./evaluate-open-paper-trades.js";

function evaluatorReturning(
  byAccount: Record<string, { closedTradeIds?: string[]; evaluationFailures?: { tradeId: string; message: string }[] }>,
) {
  const execute = vi.fn(async (input: { accountId: string }) => ({
    openTradesRead: 0,
    pendingTradesRead: 0,
    eligibleCandlesRead: 0,
    tradesClosed: byAccount[input.accountId]?.closedTradeIds?.length ?? 0,
    closedTradeIds: byAccount[input.accountId]?.closedTradeIds ?? [],
    pendingTradesFilled: 0,
    filledTradeIds: [],
    pendingTradesCancelled: 0,
    cancelledTradeIds: [],
    skippedWithoutTimeframe: 0,
    evaluationFailures: byAccount[input.accountId]?.evaluationFailures ?? [],
  }));
  return { execute, evaluator: { execute } as unknown as Pick<EvaluateOpenPaperTrades, "execute"> };
}

function accountsReturning(ids: string[]) {
  return { listAccountIdsWithOpenTrades: vi.fn(async () => ids) };
}

describe("SweepOpenPaperTradeExits", () => {
  it("evaluates every account holding an open position", async () => {
    const accounts = accountsReturning(["acct-1", "acct-2"]);
    const { execute, evaluator } = evaluatorReturning({
      "acct-1": { closedTradeIds: ["trade-a"] },
      "acct-2": { closedTradeIds: ["trade-b", "trade-c"] },
    });
    const sweep = new SweepOpenPaperTradeExits(accounts, evaluator);

    const result = await sweep.execute(new Date("2026-08-17T05:00:00.000Z"));

    expect(result.accountsSwept).toBe(2);
    expect(result.tradesClosed).toBe(3);
    expect(result.closedTradeIds).toEqual(["trade-a", "trade-b", "trade-c"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no position is open", async () => {
    const accounts = accountsReturning([]);
    const { execute, evaluator } = evaluatorReturning({});
    const sweep = new SweepOpenPaperTradeExits(accounts, evaluator);

    const result = await sweep.execute();

    expect(result).toMatchObject({ accountsSwept: 0, tradesClosed: 0, skippedBecauseBusy: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to overlap itself, because the second pass could only lose the close race", async () => {
    const accounts = accountsReturning(["acct-1"]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return {
        openTradesRead: 0, pendingTradesRead: 0, eligibleCandlesRead: 0,
        tradesClosed: 0, closedTradeIds: [], pendingTradesFilled: 0, filledTradeIds: [],
        pendingTradesCancelled: 0, cancelledTradeIds: [], skippedWithoutTimeframe: 0,
        evaluationFailures: [],
      };
    });
    const sweep = new SweepOpenPaperTradeExits(
      accounts,
      { execute } as unknown as Pick<EvaluateOpenPaperTrades, "execute">,
    );

    const first = sweep.execute();
    const second = await sweep.execute();

    expect(second.skippedBecauseBusy).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    release();
    await first;

    // And it is usable again once the first pass drains.
    await sweep.execute();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps sweeping after one account throws, so other stops stay enforced", async () => {
    const accounts = accountsReturning(["broken", "healthy"]);
    const execute = vi.fn(async (input: { accountId: string }) => {
      if (input.accountId === "broken") throw new Error("account is wedged");
      return {
        openTradesRead: 0, pendingTradesRead: 0, eligibleCandlesRead: 0,
        tradesClosed: 1, closedTradeIds: ["trade-ok"], pendingTradesFilled: 0, filledTradeIds: [],
        pendingTradesCancelled: 0, cancelledTradeIds: [], skippedWithoutTimeframe: 0,
        evaluationFailures: [],
      };
    });
    const sweep = new SweepOpenPaperTradeExits(
      accounts,
      { execute } as unknown as Pick<EvaluateOpenPaperTrades, "execute">,
    );

    const result = await sweep.execute();

    expect(result.closedTradeIds).toEqual(["trade-ok"]);
    expect(result.failures).toEqual([{ tradeId: "account:broken", message: "account is wedged" }]);
  });

  it("surfaces per-trade evaluation failures rather than swallowing them", async () => {
    const accounts = accountsReturning(["acct-1"]);
    const { evaluator } = evaluatorReturning({
      "acct-1": { evaluationFailures: [{ tradeId: "trade-x", message: "no contract key" }] },
    });
    const sweep = new SweepOpenPaperTradeExits(accounts, evaluator);

    const result = await sweep.execute();

    expect(result.failures).toEqual([{ tradeId: "trade-x", message: "no contract key" }]);
  });
});
