import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { BacktestReplayEngine } from "./run-backtest.js";
import type {
  BacktestEvaluationResult,
  BacktestMarketDataRepository,
  BacktestRepository,
  StartBacktestRunInput,
} from "../domain/backtesting.js";
import { RunBacktest, type RunBacktestInput } from "./run-backtest.js";

function context(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: new Date("2026-01-05T09:15:00.000Z"),
      closeTime: new Date("2026-01-05T15:30:00.000Z"),
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1_000,
      tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

function executionResult(): BacktestEvaluationResult {
  return {
    trades: [],
    monthlyPerformance: [],
    metrics: {
      signalCount: 0,
      skippedSignalsNoNextCandle: 0,
      skippedSignalsWhilePositionOpen: 0,
      skippedSignalsInvalidGap: 0,
      skippedSignalsInsufficientCapital: 0,
      tradeCount: 0,
      winningTradeCount: 0,
      losingTradeCount: 0,
      winRatePercent: 0,
      accuracyPercent: 0,
      grossProfit: 0,
      grossLoss: 0,
      netPnl: 0,
      profitFactor: null,
      expectancy: 0,
      maximumDrawdownPercent: 0,
      endingEquity: 100_000,
    },
  };
}

function input(): RunBacktestInput {
  return {
    strategyVersionId: "strategy-version-1",
    strategyConfiguration: {
      strategyKey: "trend-breakout",
      algorithmVersion: "strategy-v1",
    },
    instrumentId: "instrument-1",
    timeframe: "1d",
    dataWindowStart: new Date("2026-01-01T00:00:00.000Z"),
    dataWindowEnd: new Date("2026-01-31T23:59:59.999Z"),
    dataCutoffAt: new Date("2026-02-01T12:00:00.000Z"),
    execution: {
      quantity: 5,
      feePerOrder: 3.25,
      slippageBps: 12,
    },
  };
}

describe("RunBacktest", () => {
  it("persists reproducibility inputs, replays chronological evidence, and completes the run", async () => {
    const lifecycle: string[] = [];
    const started: StartBacktestRunInput[] = [];
    const completed: Array<Parameters<BacktestRepository["complete"]>[0]> = [];
    const contextInputs: Array<Parameters<BacktestMarketDataRepository["listContexts"]>[0]> = [];
    const replayInputs: Array<{
      contexts: readonly StrategyMarketContext[];
      strategyConfiguration: Record<string, unknown>;
      configuration: unknown;
    }> = [];
    const repository: BacktestRepository = {
      start: async (startInput) => {
        lifecycle.push("start");
        started.push(startInput);
        return { id: "run-1", strategyVersionId: startInput.strategyVersionId, status: "RUNNING" };
      },
      complete: async (completeInput) => {
        lifecycle.push("complete");
        completed.push(completeInput);
      },
      fail: async () => {
        throw new Error("not expected");
      },
    };
    const evidence = [context()];
    const marketData: BacktestMarketDataRepository = {
      listContexts: async (contextInput) => {
        lifecycle.push("contexts");
        contextInputs.push(contextInput);
        return evidence;
      },
    };
    const expectedResult = executionResult();
    const engine = {
      run: (contexts: readonly StrategyMarketContext[], strategyConfiguration: Record<string, unknown>, configuration: unknown) => {
        lifecycle.push("replay");
        replayInputs.push({ contexts, strategyConfiguration, configuration });
        return expectedResult;
      },
    } satisfies BacktestReplayEngine;

    const result = await new RunBacktest(repository, marketData, engine).execute(input());

    expect(lifecycle).toEqual(["start", "contexts", "replay", "complete"]);
    expect(result).toEqual({
      runId: "run-1",
      strategyVersionId: "strategy-version-1",
      instrumentId: "instrument-1",
      timeframe: "1d",
      contextsRead: 1,
      metrics: expectedResult.metrics,
    });
    expect(started).toEqual([{
      strategyVersionId: "strategy-version-1",
      instrumentId: "instrument-1",
      timeframe: "1d",
      dataWindowStart: new Date("2026-01-01T00:00:00.000Z"),
      dataWindowEnd: new Date("2026-01-31T23:59:59.999Z"),
      dataCutoffAt: new Date("2026-02-01T12:00:00.000Z"),
      engineVersion: "backtest-v1",
      configuration: {
        strategy: {
          versionId: "strategy-version-1",
          configuration: {
            strategyKey: "trend-breakout",
            algorithmVersion: "strategy-v1",
          },
        },
        execution: {
          quantity: 5,
          initialCapital: 100_000,
          feePerOrder: 3.25,
          slippageBps: 12,
          entryPolicy: "NEXT_CANDLE_OPEN",
          invalidGapPolicy: "SKIP_IF_NEXT_OPEN_IS_NOT_STRICTLY_INSIDE_SOURCE_STOP_TARGET",
          exitPolicy: "GAP_AT_OPEN_THEN_CONSERVATIVE_STOP_FIRST",
          endOfDataExitPolicy: "CLOSE_AT_FINAL_COMPLETED_CANDLE_CLOSE",
          maxConcurrentPositions: 1,
        },
        dataSelection: {
          completedCandlesOnly: true,
          evidenceDataCutoffAt: "2026-02-01T12:00:00.000Z",
        },
      },
    }]);
    expect(contextInputs).toEqual([{
      instrumentId: "instrument-1",
      timeframe: "1d",
      dataWindowStart: new Date("2026-01-01T00:00:00.000Z"),
      dataWindowEnd: new Date("2026-01-31T23:59:59.999Z"),
      dataCutoffAt: new Date("2026-02-01T12:00:00.000Z"),
    }]);
    expect(replayInputs).toEqual([{
      contexts: evidence,
      strategyConfiguration: {
        strategyKey: "trend-breakout",
        algorithmVersion: "strategy-v1",
      },
      configuration: expect.objectContaining({ quantity: 5, initialCapital: 100_000, feePerOrder: 3.25, slippageBps: 12 }),
    }]);
    expect(completed).toEqual([{
      runId: "run-1",
      metrics: expectedResult.metrics,
      trades: [],
      monthlyPerformance: [],
    }]);
  });

  it("marks a started run failed when historical context loading fails and never completes it", async () => {
    const completed: unknown[] = [];
    const failures: Array<{ runId: string; errorMessage: string }> = [];
    const repository: BacktestRepository = {
      start: async () => ({ id: "run-context-error", strategyVersionId: "strategy-version-1", status: "RUNNING" }),
      complete: async (completeInput) => { completed.push(completeInput); },
      fail: async (runId, errorMessage) => { failures.push({ runId, errorMessage }); },
    };
    const marketData: BacktestMarketDataRepository = {
      listContexts: async () => { throw new Error("Historical evidence is unavailable."); },
    };
    const engine = {
      run: () => { throw new Error("not expected"); },
    } satisfies BacktestReplayEngine;

    await expect(new RunBacktest(repository, marketData, engine).execute(input()))
      .rejects.toThrow("Historical evidence is unavailable.");

    expect(failures).toEqual([{ runId: "run-context-error", errorMessage: "Historical evidence is unavailable." }]);
    expect(completed).toEqual([]);
  });

  it("marks a started run failed when replay throws and never completes it", async () => {
    const completed: unknown[] = [];
    const failures: Array<{ runId: string; errorMessage: string }> = [];
    const repository: BacktestRepository = {
      start: async () => ({ id: "run-replay-error", strategyVersionId: "strategy-version-1", status: "RUNNING" }),
      complete: async (completeInput) => { completed.push(completeInput); },
      fail: async (runId, errorMessage) => { failures.push({ runId, errorMessage }); },
    };
    const marketData: BacktestMarketDataRepository = {
      listContexts: async () => [context()],
    };
    const engine = {
      run: () => { throw new Error("Replay invariant violated."); },
    } satisfies BacktestReplayEngine;

    await expect(new RunBacktest(repository, marketData, engine).execute(input()))
      .rejects.toThrow("Replay invariant violated.");

    expect(failures).toEqual([{ runId: "run-replay-error", errorMessage: "Replay invariant violated." }]);
    expect(completed).toEqual([]);
  });
});
