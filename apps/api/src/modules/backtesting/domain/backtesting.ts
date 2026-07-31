import type { StrategyMarketContext, TradeSide } from "../../strategy-engine/domain/strategy.js";

export type BacktestRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type BacktestExitReason = "STOP_LOSS" | "TARGET" | "SIGNAL" | "END_OF_DATA";

/**
 * How many units a signal is filled with.
 *
 * `FIXED_QUANTITY` buys the same number of units regardless of how far away the
 * stop is. When a strategy sets its stop from ATR, that makes the capital at risk
 * proportional to volatility, so high-volatility trades dominate the result — a
 * measured example is in `docs/next-session-brief.md` §3.4b, where momentum-scalp's
 * per-trade risk ranged from 0.8 to 196 points.
 *
 * `CONSTANT_RISK_FRACTION` instead solves for the quantity that puts the same
 * amount of capital at risk on every trade, so P/L reflects the rule's hit rate
 * rather than which bars happened to be volatile.
 */
export type BacktestPositionSizing = "FIXED_QUANTITY" | "CONSTANT_RISK_FRACTION";

export interface BacktestConfiguration {
  quantity: number;
  initialCapital: number;
  feePerOrder: number;
  slippageBps: number;
  positionSizing: BacktestPositionSizing;
  /**
   * Fraction of *initial* capital risked per trade, read only under
   * `CONSTANT_RISK_FRACTION`. Deliberately measured against initial rather than
   * running equity: risking a fraction of current equity compounds, which makes
   * the result depend on trade order and re-introduces the unequal-risk problem
   * this setting exists to remove.
   */
  riskFractionPerTrade: number;
  /**
   * Fraction of a position's notional that must be available as capital to open
   * it. `1` is cash-secured and is the default, which keeps existing runs
   * unchanged.
   *
   * This exists because cash-securing and constant-risk sizing are in direct
   * tension. Risking 1% of capital behind a stop that sits 0.3% away implies a
   * notional of roughly 3x capital, so a cash-secured account rejects almost
   * every risk-sized signal — measured on NIFTY50 1d, 97 of 118 signals were
   * skipped for insufficient capital, which reports a funding artifact as
   * though it were an absence of signal. Index futures are margined at roughly
   * 0.15-0.20 of notional, so setting this to that range models the account the
   * strategy would actually be traded in.
   */
  marginFraction: number;
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
  /** Risk-sized signals whose stop was so wide that the budget bought under one unit. */
  skippedSignalsUnsizable: number;
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
