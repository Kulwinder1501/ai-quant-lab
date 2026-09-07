import { describe, expect, it } from "vitest";
import { PartialExitPaperTrade } from "./partial-exit-paper-trade.js";
import type {
  ExecuteExitSliceInput,
  PaperTrade,
  PaperTradePartialExit,
  PaperTradeRepository,
} from "../domain/paper-trading.js";

function createMockRepo(initialTrade: PaperTrade): {
  repo: PaperTradeRepository;
  slices: PaperTradePartialExit[];
  currentTrade: PaperTrade;
} {
  const slices: PaperTradePartialExit[] = [];
  let currentTrade = { ...initialTrade };

  const repo: PaperTradeRepository = {
    openFromTradeIdea: async () => { throw new Error("not used"); },
    findOpenById: async () => (currentTrade.status === "OPEN" ? currentTrade : null),
    listOpenByAccount: async () => (currentTrade.status === "OPEN" ? [currentTrade] : []),
    listPendingByAccount: async () => [],
    fillPendingTrade: async () => { throw new Error("not used"); },
    close: async () => { throw new Error("not used"); },
    findAccountPerformanceData: async () => null,
    listPartialExitsByTradeId: async () => slices,
    executeExitSlice: async (input: ExecuteExitSliceInput) => {
      if (input.quantity > currentTrade.remainingQuantity) {
        throw new Error(`Exit quantity (${input.quantity}) exceeds remaining trade quantity (${currentTrade.remainingQuantity}).`);
      }

      if (input.idempotencyKey && slices.some((s) => s.idempotencyKey === input.idempotencyKey)) {
        return currentTrade; // Idempotent no-op
      }

      const directionSign = currentTrade.side === "LONG" ? 1 : -1;
      const sliceGrossPnl = (input.exitPrice - currentTrade.entryPrice) * input.quantity * directionSign;
      const sliceNetPnl = sliceGrossPnl - input.exitFees;

      const slice: PaperTradePartialExit = {
        id: `slice-${slices.length + 1}`,
        paperTradeId: currentTrade.id,
        exitPrice: input.exitPrice,
        quantity: input.quantity,
        exitReason: input.exitReason,
        exitFees: input.exitFees,
        realizedPnl: sliceNetPnl,
        exitedAt: input.exitedAt,
        idempotencyKey: input.idempotencyKey ?? null,
        notes: input.notes ?? null,
        createdAt: new Date(),
      };
      slices.push(slice);

      const newRemaining = Math.max(0, currentTrade.remainingQuantity - input.quantity);
      const isFullyClosed = newRemaining === 0;

      const totalSlicePnl = slices.reduce((sum, s) => sum + s.realizedPnl, 0);
      const entryFee = ((currentTrade.feeBreakdown?.entry as any)?.total as number) ?? 0;
      const parentNetPnl = totalSlicePnl - entryFee;

      currentTrade = {
        ...currentTrade,
        remainingQuantity: newRemaining,
        status: isFullyClosed ? "CLOSED" : "OPEN",
        closedAt: isFullyClosed ? input.exitedAt : null,
        exitPrice: input.exitPrice,
        exitReason: isFullyClosed ? input.exitReason : currentTrade.exitReason,
        fees: currentTrade.fees + input.exitFees,
        realizedPnl: isFullyClosed ? parentNetPnl : null,
      };

      return currentTrade;
    },
  };

  return { repo, slices, currentTrade: currentTrade };
}

describe("PartialExitPaperTrade", () => {
  it("executes multi-stage scaling (T1, T2, Runner) with unified exit slice accounting", async () => {
    // 3 lots of NIFTY options = 225 units @ 100 entry, entry fee = 20
    const initialTrade: PaperTrade = {
      id: "trade-1",
      accountId: "acc-1",
      tradeIdeaId: "idea-1",
      instrumentId: "inst-1",
      timeframe: "5m",
      side: "LONG",
      status: "OPEN",
      quantity: 225,
      remainingQuantity: 225,
      entryPrice: 100,
      stopLoss: 80,
      targetPrice: 150,
      openedAt: new Date("2026-08-16T09:30:00Z"),
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      realizedPnl: null,
      fees: 20,
      feeBreakdown: { entry: { total: 20 } },
      slippage: 0,
      notes: "",
    };

    const { repo, slices } = createMockRepo(initialTrade);
    const useCase = new PartialExitPaperTrade(repo);

    // Stage 1: T1 exit (1 lot = 75 units @ 120, exit fee = 10)
    // Slice gross = (120 - 100) * 75 = 1500, net = 1500 - 10 = 1490
    const tradeAfterT1 = await useCase.execute({
      paperTradeId: "trade-1",
      exitPrice: 120,
      quantity: 75,
      exitReason: "T1_TARGET",
      exitFees: 10,
      exitedAt: new Date("2026-08-16T09:45:00Z"),
      idempotencyKey: "t1-trade-1",
    });

    expect(tradeAfterT1.remainingQuantity).toBe(150);
    expect(tradeAfterT1.status).toBe("OPEN");
    expect(slices).toHaveLength(1);
    expect(slices[0].realizedPnl).toBe(1490);

    // Idempotency check: duplicate call does not exit extra quantity
    const tradeAfterDup = await useCase.execute({
      paperTradeId: "trade-1",
      exitPrice: 120,
      quantity: 75,
      exitReason: "T1_TARGET",
      exitFees: 10,
      exitedAt: new Date("2026-08-16T09:45:00Z"),
      idempotencyKey: "t1-trade-1",
    });
    expect(tradeAfterDup.remainingQuantity).toBe(150);
    expect(slices).toHaveLength(1);

    // Stage 2: T2 exit (1 lot = 75 units @ 140, exit fee = 10)
    // Slice gross = (140 - 100) * 75 = 3000, net = 3000 - 10 = 2990
    const tradeAfterT2 = await useCase.execute({
      paperTradeId: "trade-1",
      exitPrice: 140,
      quantity: 75,
      exitReason: "T2_TARGET",
      exitFees: 10,
      exitedAt: new Date("2026-08-16T10:00:00Z"),
      idempotencyKey: "t2-trade-1",
    });

    expect(tradeAfterT2.remainingQuantity).toBe(75);
    expect(tradeAfterT2.status).toBe("OPEN");
    expect(slices).toHaveLength(2);
    expect(slices[1].realizedPnl).toBe(2990);

    // Stage 3: Runner exit (remaining 75 units @ 130 trailing stop, exit fee = 10)
    // Slice gross = (130 - 100) * 75 = 2250, net = 2250 - 10 = 2240
    const tradeAfterRunner = await useCase.execute({
      paperTradeId: "trade-1",
      exitPrice: 130,
      quantity: 75,
      exitReason: "RUNNER_TRAIL",
      exitFees: 10,
      exitedAt: new Date("2026-08-16T10:30:00Z"),
      idempotencyKey: "runner-trade-1",
    });

    expect(tradeAfterRunner.remainingQuantity).toBe(0);
    expect(tradeAfterRunner.status).toBe("CLOSED");
    expect(tradeAfterRunner.closedAt).toEqual(new Date("2026-08-16T10:30:00Z"));
    expect(slices).toHaveLength(3);
    expect(slices[2].realizedPnl).toBe(2240);

    // Total Net P&L = SUM(slices) - entry_fees = (1490 + 2990 + 2240) - 20 = 6720 - 20 = 6700
    expect(tradeAfterRunner.realizedPnl).toBe(6700);
  });

  it("rejects exit quantity greater than remaining quantity", async () => {
    const initialTrade: PaperTrade = {
      id: "trade-2",
      accountId: "acc-1",
      tradeIdeaId: "idea-2",
      instrumentId: "inst-1",
      timeframe: "5m",
      side: "LONG",
      status: "OPEN",
      quantity: 75,
      remainingQuantity: 75,
      entryPrice: 100,
      stopLoss: 80,
      targetPrice: 150,
      openedAt: new Date("2026-08-16T09:30:00Z"),
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      realizedPnl: null,
      fees: 20,
      slippage: 0,
      notes: "",
    };

    const { repo } = createMockRepo(initialTrade);
    const useCase = new PartialExitPaperTrade(repo);

    await expect(
      useCase.execute({
        paperTradeId: "trade-2",
        exitPrice: 120,
        quantity: 150, // Exceeds 75
        exitReason: "T1_TARGET",
        exitFees: 10,
        exitedAt: new Date(),
      }),
    ).rejects.toThrow(/exceeds remaining trade quantity/);
  });
});
