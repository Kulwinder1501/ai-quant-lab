import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { describe, expect, it, vi } from "vitest";
import type {
  BacktestMetrics,
  BacktestMonthlyPerformance,
  BacktestTrade,
  StartBacktestRunInput,
} from "../domain/backtesting.js";
import { PostgresBacktestRepository } from "./postgres-backtest-repository.js";

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

type QueryHandler = (text: string, values: unknown[] | undefined) => Promise<{ rows: unknown[] }> | { rows: unknown[] };

function fakePool(handler: QueryHandler): {
  pool: DatabasePool;
  calls: QueryCall[];
  release: ReturnType<typeof vi.fn>;
} {
  const calls: QueryCall[] = [];
  const release = vi.fn();
  const query = async (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    calls.push({ text, values });
    return handler(text, values);
  };
  const client = { query, release };
  return {
    pool: {
      connect: async () => client,
      query,
    } as unknown as DatabasePool,
    calls,
    release,
  };
}

function startInput(): StartBacktestRunInput {
  return {
    strategyVersionId: "strategy-version-1",
    instrumentId: "instrument-1",
    timeframe: "1d",
    dataWindowStart: new Date("2026-01-01T00:00:00.000Z"),
    dataWindowEnd: new Date("2026-02-01T00:00:00.000Z"),
    dataCutoffAt: new Date("2026-02-05T00:00:00.000Z"),
    engineVersion: "backtest-v1",
    configuration: { backtest: { quantity: 1 }, strategy: { version: 1 } },
  };
}

function metrics(): BacktestMetrics {
  return {
    signalCount: 1,
    skippedSignalsNoNextCandle: 0,
    skippedSignalsWhilePositionOpen: 0,
    skippedSignalsInvalidGap: 0,
    skippedSignalsInsufficientCapital: 0,
    tradeCount: 1,
    winningTradeCount: 1,
    losingTradeCount: 0,
    winRatePercent: 100,
    accuracyPercent: 100,
    grossProfit: 20,
    grossLoss: 0,
    netPnl: 20,
    profitFactor: null,
    expectancy: 20,
    maximumDrawdownPercent: 0,
    endingEquity: 100_020,
  };
}

function trade(): BacktestTrade {
  return {
    instrumentId: "instrument-1",
    side: "LONG",
    entryTime: new Date("2026-01-05T03:45:00.000Z"),
    exitTime: new Date("2026-01-06T10:00:00.000Z"),
    entryPrice: 100,
    exitPrice: 110,
    quantity: 2,
    pnl: 20,
    returnPercent: 10,
    exitReason: "TARGET",
    reasoning: ["Signal source candle: candle-1."],
  };
}

function monthlyPerformance(): BacktestMonthlyPerformance {
  return {
    monthStart: new Date("2026-01-01T00:00:00.000Z"),
    tradeCount: 1,
    winningTradeCount: 1,
    grossProfit: 20,
    grossLoss: 0,
    netPnl: 20,
    maxDrawdownPercent: 0,
  };
}

describe("PostgresBacktestRepository", () => {
  it("starts a running run and associates its instrument inside one transaction", async () => {
    const { pool, calls, release } = fakePool((text) => {
      if (text.includes("INSERT INTO backtest_runs")) {
        return { rows: [{ id: "run-1", strategy_version_id: "strategy-version-1", status: "RUNNING" }] };
      }
      return { rows: [] };
    });
    const input = startInput();

    await expect(new PostgresBacktestRepository(pool).start(input)).resolves.toEqual({
      id: "run-1",
      strategyVersionId: "strategy-version-1",
      status: "RUNNING",
    });

    expect(calls[0]?.text).toBe("BEGIN");
    expect(calls[1]?.text).toContain("INSERT INTO backtest_runs");
    expect(calls[1]?.values).toEqual([
      input.strategyVersionId,
      input.timeframe,
      input.dataWindowStart,
      input.dataWindowEnd,
      input.dataCutoffAt,
      input.engineVersion,
      JSON.stringify(input.configuration),
    ]);
    expect(calls[2]?.text).toContain("INSERT INTO backtest_run_instruments");
    expect(calls[2]?.values).toEqual(["run-1", input.instrumentId]);
    expect(calls[3]?.text).toBe("COMMIT");
    expect(calls).toHaveLength(4);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("writes trades, monthly performance, and final metrics before committing a completed run", async () => {
    const { pool, calls, release } = fakePool((text) => {
      if (text.includes("SELECT id, status")) {
        return { rows: [{ id: "run-1", status: "RUNNING" }] };
      }
      if (text.includes("UPDATE backtest_runs")) {
        return { rows: [{ id: "run-1" }] };
      }
      return { rows: [] };
    });
    const resultMetrics = metrics();
    const completedTrade = trade();
    const completedMonth = monthlyPerformance();

    await expect(new PostgresBacktestRepository(pool).complete({
      runId: "run-1",
      metrics: resultMetrics,
      trades: [completedTrade],
      monthlyPerformance: [completedMonth],
    })).resolves.toBeUndefined();

    expect(calls[0]?.text).toBe("BEGIN");
    expect(calls[1]?.text).toContain("FOR UPDATE");
    expect(calls[2]?.text).toContain("INSERT INTO backtest_trades");
    expect(calls[2]?.values).toEqual([
      "run-1",
      completedTrade.instrumentId,
      completedTrade.side,
      completedTrade.entryTime,
      completedTrade.exitTime,
      completedTrade.entryPrice,
      completedTrade.exitPrice,
      completedTrade.quantity,
      completedTrade.pnl,
      completedTrade.returnPercent,
      completedTrade.exitReason,
      JSON.stringify(completedTrade.reasoning),
    ]);
    expect(calls[3]?.text).toContain("INSERT INTO backtest_monthly_performance");
    expect(calls[3]?.values).toEqual([
      "run-1",
      "2026-01-01",
      completedMonth.tradeCount,
      completedMonth.winningTradeCount,
      completedMonth.grossProfit,
      completedMonth.grossLoss,
      completedMonth.netPnl,
      completedMonth.maxDrawdownPercent,
    ]);
    expect(calls[4]?.text).toContain("status = 'COMPLETED'");
    expect(calls[4]?.values).toEqual(["run-1", JSON.stringify(resultMetrics)]);
    expect(calls[5]?.text).toBe("COMMIT");
    expect(calls).toHaveLength(6);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls a completion transaction back when a result row cannot be persisted", async () => {
    const { pool, calls, release } = fakePool((text) => {
      if (text.includes("SELECT id, status")) {
        return { rows: [{ id: "run-1", status: "RUNNING" }] };
      }
      if (text.includes("INSERT INTO backtest_trades")) {
        throw new Error("trade insert failed");
      }
      return { rows: [] };
    });

    await expect(new PostgresBacktestRepository(pool).complete({
      runId: "run-1",
      metrics: metrics(),
      trades: [trade()],
      monthlyPerformance: [monthlyPerformance()],
    })).rejects.toThrow("trade insert failed");

    expect(calls.map((call) => call.text.trim())).toEqual([
      "BEGIN",
      expect.stringContaining("SELECT id, status"),
      expect.stringContaining("INSERT INTO backtest_trades"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("marks only a queued or running run as failed without opening a result transaction", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));

    await expect(new PostgresBacktestRepository(pool).fail("run-1", "historical data unavailable")).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("status = 'FAILED'");
    expect(calls[0]?.text).toContain("status IN ('QUEUED', 'RUNNING')");
    expect(calls[0]?.values).toEqual(["run-1", "historical data unavailable"]);
  });
});
