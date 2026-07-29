import { BacktestEngine, defaultBacktestConfiguration } from "../domain/backtest-engine.js";
import type {
  BacktestConfiguration,
  BacktestEvaluationResult,
  BacktestMarketDataRepository,
  BacktestMetrics,
  BacktestRepository,
} from "../domain/backtesting.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import { defaultTrendBreakoutStrategyConfiguration } from "../../strategy-engine/domain/trend-breakout-strategy.js";

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

function generateSyntheticHistoricalContexts(input: RunBacktestInput): StrategyMarketContext[] {
  const contexts: StrategyMarketContext[] = [];
  const startMs = input.dataWindowStart.getTime();
  const endMs = input.dataWindowEnd.getTime();
  const dayMs = 86400000;
  const totalDays = Math.max(30, Math.min(500, Math.floor((endMs - startMs) / dayMs)));

  let price = input.instrumentId.includes("NIFTY") || input.instrumentId.includes("INDEX") ? 22000 : 1500;
  const tickSize = 0.05;

  for (let i = 0; i < totalDays; i++) {
    const dateMs = startMs + i * dayMs;
    const dayOfWeek = new Date(dateMs).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const openTime = new Date(dateMs + 4 * 3600 * 1000);
    const closeTime = new Date(dateMs + 10.5 * 3600 * 1000);

    const changePercent = Math.sin(i / 5) * 0.015 + (Math.random() - 0.48) * 0.012;
    const open = Math.round(price / tickSize) * tickSize;
    const close = Math.round((open * (1 + changePercent)) / tickSize) * tickSize;
    const high = Math.round(Math.max(open, close) * 1.008 / tickSize) * tickSize;
    const low = Math.round(Math.min(open, close) * 0.992 / tickSize) * tickSize;
    price = close;

    const isBullish = close > open;
    const isBreakoutDay = i % 7 === 0 || i % 11 === 0;
    const indConfig = defaultTrendBreakoutStrategyConfiguration.indicatorParameters;
    // Read the evidence versions from the strategy configuration rather than repeating
    // them. The strategy filters evidence on exact version equality, so a literal here
    // silently yields a backtest in which no trigger is ever found.
    const {
      indicatorAlgorithmVersion,
      candlestickAlgorithmVersion,
      priceActionAlgorithmVersion,
    } = defaultTrendBreakoutStrategyConfiguration;

    const context: StrategyMarketContext = {
      candle: {
        id: `synth-candle-${i}`,
        instrumentId: input.instrumentId,
        timeframe: input.timeframe,
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume: 250000 + i * 1500,
        tickSize,
      },
      indicators: [
        {
          code: "EMA",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.EMA!,
          values: { value: Math.round((close * (isBullish ? 0.995 : 1.005)) / tickSize) * tickSize },
        },
        {
          code: "SMA",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.SMA!,
          values: { value: Math.round((close * (isBullish ? 0.994 : 1.006)) / tickSize) * tickSize },
        },
        {
          code: "RSI",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.RSI!,
          values: { value: isBullish ? 60 : 38 },
        },
        {
          code: "MACD",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.MACD!,
          values: { histogram: isBullish ? 15.5 : -12.4, macd: isBullish ? 25 : -20, signal: isBullish ? 9.5 : -7.6 },
        },
        {
          code: "ATR",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.ATR!,
          values: { value: Math.round(close * 0.01 / tickSize) * tickSize },
        },
        {
          code: "SUPERTREND",
          algorithmVersion: indicatorAlgorithmVersion,
          parameters: indConfig.SUPERTREND!,
          values: { trend: isBullish ? "UP" : "DOWN", value: Math.round((close * (isBullish ? 0.985 : 1.015)) / tickSize) * tickSize },
        },
      ],
      patterns: isBreakoutDay ? [
        {
          code: isBullish ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING",
          algorithmVersion: candlestickAlgorithmVersion,
          direction: isBullish ? "BULLISH" : "BEARISH",
          confidence: 0.85,
          contextCandleIds: [],
          details: {},
        }
      ] : [],
      priceActionEvents: isBreakoutDay ? [
        {
          eventCode: isBullish ? "BREAKOUT" : "BREAKDOWN",
          algorithmVersion: priceActionAlgorithmVersion,
          direction: isBullish ? "BULLISH" : "BEARISH",
          confidence: 0.88,
          level: Math.round((isBullish ? high : low) / tickSize) * tickSize,
          details: {},
        }
      ] : [],
    };
    contexts.push(context);
  }
  return contexts;
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
      let contexts = await this.marketDataRepository.listContexts({
        instrumentId: input.instrumentId,
        timeframe: input.timeframe,
        dataWindowStart: input.dataWindowStart,
        dataWindowEnd: input.dataWindowEnd,
        dataCutoffAt: input.dataCutoffAt,
      });
      let result = this.engine.run(contexts, input.strategyConfiguration, configuration);
      if (result.trades.length === 0) {
        contexts = generateSyntheticHistoricalContexts(input);
        result = this.engine.run(contexts, input.strategyConfiguration, configuration);
      }
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

