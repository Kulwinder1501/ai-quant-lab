import type { StrategyMarketContext, TradeSide } from "../../strategy-engine/domain/strategy.js";

export type BacktestRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type BacktestExitReason =
  | "STOP_LOSS" | "TARGET" | "SIGNAL" | "END_OF_DATA" | "TRAP_DETECTED"
  | "OPPOSING_LIQUIDITY_SWEEP" | "MOMENTUM_STALL";

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
  /**
   * `NEXT_CANDLE_OPEN` (default): a signal known at a candle's close fills at the next candle's open.
   *
   * `LIMIT_AT_PROPOSAL_ENTRY`: the proposal's `entryPrice` is a RESTING LIMIT, working from the bar
   * after the signal. It fills on the first bar that trades THROUGH the level by at least one tick
   * (queue position is unknowable, so a bare touch does not count), at the limit or at the open if the
   * bar gaps through it. Assumptions, all deliberately pessimistic where they have to choose:
   *   - no entry slippage (a limit never fills worse than its price); exit slippage and fees unchanged;
   *   - on the fill bar only the STOP is evaluated -- the bar's high/low ordering is unknown, so a
   *     target that may have printed before the fill is not credited until the next bar;
   *   - an unfilled order is cancelled when price reaches the target without retracing, when the
   *     proposal's `expiresAt` passes, or after `limitOrderMaxBars` bars;
   *   - a working order occupies a position slot, exactly as a pending market fill does.
   * This exists because ICT entries are retrace limits and the old policy could not express one, so
   * the OTE / POI-preference / BPR arms were untestable rather than failed.
   */
  entryPolicy: "NEXT_CANDLE_OPEN" | "LIMIT_AT_PROPOSAL_ENTRY";
  /** Bars a limit order may work before it is cancelled. Read only under `LIMIT_AT_PROPOSAL_ENTRY`. Default 6. */
  limitOrderMaxBars?: number;
  /**
   * Take at most one trade per `evidence.setupId`. Live paper trading already enforces this with a
   * unique index on the setup identity, so a backtest that re-enters the same setup after a stop
   * counts trades the live system would never have taken. Off by default so recorded runs reproduce.
   */
  oneTradePerSetup?: boolean;
  invalidGapPolicy: "SKIP_IF_NEXT_OPEN_IS_NOT_STRICTLY_INSIDE_SOURCE_STOP_TARGET";
  exitPolicy: "GAP_AT_OPEN_THEN_CONSERVATIVE_STOP_FIRST";
  endOfDataExitPolicy: "CLOSE_AT_FINAL_COMPLETED_CANDLE_CLOSE";
  /**
   * How many positions may be open at once. Integer >= 1; 1 is the default.
   *
   * Was the literal type `1`, which encoded "the engine only supports one" in the type system --
   * honest while true, but it made the constraint invisible to callers who could otherwise have
   * asked for more. The engine now admits N, so the type is the value's real domain and
   * `assertConfiguration` enforces the bound.
   *
   * Raising it changes what a run measures, so it is recorded in the run's `configuration` jsonb:
   * a concurrent run must never be comparable-by-accident with a sequential one.
   */
  maxConcurrentPositions: number;
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
  /** Limit orders that never filled (expired, or the target printed without a retrace). Present only under limit entry. */
  skippedSignalsUnfilledLimit?: number;
  /** Signals dropped because their setup had already been traded. Present only under `oneTradePerSetup`. */
  skippedSignalsDuplicateSetup?: number;
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
