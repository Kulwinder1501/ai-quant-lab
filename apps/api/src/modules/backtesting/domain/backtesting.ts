import type { StrategyMarketContext, TradeSide } from "../../strategy-engine/domain/strategy.js";

export type BacktestRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type BacktestExitReason = "STOP_LOSS" | "TARGET" | "SIGNAL" | "END_OF_DATA";

export interface BacktestConfiguration {
  quantity: number;
  initialCapital: number;
  feePerOrder: number;
  slippageBps: number;
  entryPolicy: "NEXT_CANDLE_OPEN";
  invalidGapPolicy: "SKIP_IF_NEXT_OPEN_IS_NOT_STRICTLY_INSIDE_SOURCE_STOP_TARGET";
  exitPolicy: "GAP_AT_OPEN_THEN_CONSERVATIVE_STOP_FIRST";
  endOfDataExitPolicy: "CLOSE_AT_FINAL_COMPLETED_CANDLE_CLOSE";
  maxConcurrentPositions: 1;
}

export interface BacktestTrade {
  instrumentId: string;
  side: TradeSide;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  returnPercent: number;
  exitReason: BacktestExitReason;
  reasoning: string[];
}

export interface BacktestMonthlyPerformance {
  monthStart: Date;
  tradeCount: number;
  winningTradeCount: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  maxDrawdownPercent: number;
}

export interface BacktestMetrics {
  signalCount: number;
  skippedSignalsNoNextCandle: number;
  skippedSignalsWhilePositionOpen: number;
  skippedSignalsInvalidGap: number;
  skippedSignalsInsufficientCapital: number;
  tradeCount: number;
  winningTradeCount: number;
  losingTradeCount: number;
  winRatePercent: number;
  /** Same value as win rate for a deterministic rule-based strategy; not a classifier score. */
  accuracyPercent: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  maximumDrawdownPercent: number;
  endingEquity: number;
}

export interface BacktestEvaluationResult {
  trades: BacktestTrade[];
  monthlyPerformance: BacktestMonthlyPerformance[];
  metrics: BacktestMetrics;
}

export interface BacktestRun {
  id: string;
  strategyVersionId: string;
  status: BacktestRunStatus;
}

export interface StartBacktestRunInput {
  strategyVersionId: string;
  instrumentId: string;
  timeframe: string;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  dataCutoffAt: Date;
  engineVersion: string;
  configuration: Record<string, unknown>;
}

export interface BacktestRepository {
  start(input: StartBacktestRunInput): Promise<BacktestRun>;
  complete(input: {
    runId: string;
    metrics: BacktestMetrics;
    trades: BacktestTrade[];
    monthlyPerformance: BacktestMonthlyPerformance[];
  }): Promise<void>;
  fail(runId: string, errorMessage: string): Promise<void>;
}

/** Provides chronological, completed-candle evidence as it was available by a data cutoff. */
export interface BacktestMarketDataRepository {
  listContexts(input: {
    instrumentId: string;
    timeframe: string;
    dataWindowStart: Date;
    dataWindowEnd: Date;
    dataCutoffAt: Date;
  }): Promise<StrategyMarketContext[]>;
}
