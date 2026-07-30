import { BacktestEngine, defaultBacktestConfiguration } from "../domain/backtest-engine.js";
import type {
  BacktestConfiguration,
  BacktestEvaluationResult,
  BacktestMarketDataRepository,
  BacktestMetrics,
  BacktestRepository,
} from "../domain/backtesting.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";

export interface BacktestExecutionOverrides {
  quantity?: number;
  initialCapital?: number;
  feePerOrder?: number;
  slippageBps?: number;
}

export interface RunBacktestInput {
  strategyVersionId: string;
  strategyConfiguration: Record<string, unknown>;
  instrumentId: string;
  timeframe: string;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  dataCutoffAt: Date;
  execution?: BacktestExecutionOverrides;
  engineVersion?: string;
}

export interface RunBacktestResult {
  runId: string;
  strategyVersionId: string;
  instrumentId: string;
  timeframe: string;
  contextsRead: number;
  metrics: BacktestMetrics;
}

/** Kept small so orchestration can be exercised without a database or live strategy. */
export interface BacktestReplayEngine {
  run(
    contexts: readonly StrategyMarketContext[],
    strategyConfiguration: Record<string, unknown>,
    configuration: BacktestConfiguration,
  ): BacktestEvaluationResult;
}

function assertNonBlank(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must not be blank.`);
  }
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
}

function resolveConfiguration(overrides: BacktestExecutionOverrides | undefined): BacktestConfiguration {
  return {
    ...defaultBacktestConfiguration,
    ...overrides,
  };
}

/**
 * Coordinates a reproducible historical replay. The full immutable strategy
 * configuration, execution assumptions, and data cutoff are saved with the
 * run before any market data is read.
 */
export class RunBacktest {
  constructor(
    private readonly backtestRepository: BacktestRepository,
    private readonly marketDataRepository: BacktestMarketDataRepository,
    private readonly engine: BacktestReplayEngine = new BacktestEngine(),
  ) {}

  async execute(input: RunBacktestInput): Promise<RunBacktestResult> {
    assertNonBlank(input.strategyVersionId, "Strategy version ID");
    assertNonBlank(input.instrumentId, "Instrument ID");
    assertNonBlank(input.timeframe, "Timeframe");
    assertDate(input.dataWindowStart, "Data-window start");
    assertDate(input.dataWindowEnd, "Data-window end");
    assertDate(input.dataCutoffAt, "Data cutoff");
    if (input.dataWindowEnd.getTime() <= input.dataWindowStart.getTime()) {
      throw new Error("Data-window end must be after data-window start.");
    }

    const configuration = resolveConfiguration(input.execution);
    const run = await this.backtestRepository.start({
      strategyVersionId: input.strategyVersionId,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      dataWindowStart: input.dataWindowStart,
      dataWindowEnd: input.dataWindowEnd,
      dataCutoffAt: input.dataCutoffAt,
      engineVersion: input.engineVersion?.trim() || "backtest-v1",
      configuration: {
        strategy: {
          versionId: input.strategyVersionId,
          configuration: input.strategyConfiguration,
        },
        execution: configuration,
        dataSelection: {
          completedCandlesOnly: true,
          evidenceDataCutoffAt: input.dataCutoffAt.toISOString(),
        },
      },
    });

    try {
      // Real evidence only. A previous version fell back to a Math.random()
      // synthetic random-walk whenever the strategy produced zero trades on the
      // real data, and reported its metrics with no marker distinguishing them
      // from a genuine result. That contradicts this class's reproducible-replay
      // contract and, in a backtester, silently presents fabricated performance
      // as real — so a strategy that legitimately finds no signals now returns an
      // honest empty result instead.
      const contexts = await this.marketDataRepository.listContexts({
        instrumentId: input.instrumentId,
        timeframe: input.timeframe,
        dataWindowStart: input.dataWindowStart,
        dataWindowEnd: input.dataWindowEnd,
        dataCutoffAt: input.dataCutoffAt,
      });
      const result = this.engine.run(contexts, input.strategyConfiguration, configuration);
      await this.backtestRepository.complete({
        runId: run.id,
        metrics: result.metrics,
        trades: result.trades,
        monthlyPerformance: result.monthlyPerformance,
      });
      return {
        runId: run.id,
        strategyVersionId: input.strategyVersionId,
        instrumentId: input.instrumentId,
        timeframe: input.timeframe,
        contextsRead: contexts.length,
        metrics: result.metrics,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await this.backtestRepository.fail(run.id, errorMessage);
      } catch (failure) {
        const failureMessage = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`Backtest failed and its failure status could not be persisted: ${failureMessage}`, { cause: error });
      }
      throw error;
    }
  }
}

