import type { PaperTradeExitReason, PaperTradeStatus } from "./paper-trading.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/**
 * The read model behind the Trade History ledger. It is a chronological audit of
 * simulated fills across every local paper account — never an order book, and
 * never a route to a broker.
 */
export interface PaperTradeHistoryRecord {
  /** Every row is a local simulation record, not an executable or executed order. */
  simulatedOnly: true;
  id: string;
  accountId: string;
  accountName: string;
  instrumentId: string;
  instrumentSymbol: string;
  instrumentName: string;
  timeframe: string | null;
  tradeIdeaId: string | null;
  side: TradeSide;
  status: PaperTradeStatus;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  openedAt: Date;
  closedAt: Date | null;
  exitPrice: number | null;
  exitReason: PaperTradeExitReason | null;
  realizedPnl: number | null;
  /** Realised return on the position's entry notional, in percent. */
  returnPercent: number | null;
  /** Realised profit or loss as a multiple of the trade's initial risk. */
  rewardMultiple: number | null;
  /** Whole minutes the position was held, once it has closed. */
  holdingMinutes: number | null;
  fees: number;
  slippage: number;
  notes: string;
}

export type TradeOutcomeFilter = "WIN" | "LOSS" | "BREAK_EVEN";

export interface ListPaperTradeHistoryInput {
  accountId?: string;
  instrumentSymbol?: string;
  status?: PaperTradeStatus;
  side?: TradeSide;
  exitReason?: PaperTradeExitReason;
  outcome?: TradeOutcomeFilter;
  openedFrom?: Date;
  openedTo?: Date;
  limit: number;
}

/** Realised aggregates over exactly the rows the caller is looking at. */
export interface PaperTradeHistorySummary {
  tradeCount: number;
  openTradeCount: number;
  closedTradeCount: number;
  winningTradeCount: number;
  losingTradeCount: number;
  breakEvenTradeCount: number;
  winRatePercent: number | null;
  grossProfit: number;
  grossLoss: number;
  netRealizedPnl: number;
  /** Gross profit divided by gross loss; null when nothing has been lost yet. */
  profitFactor: number | null;
  /** Average realised profit or loss per closed trade. */
  expectancy: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageRewardMultiple: number | null;
  averageHoldingMinutes: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  totalFees: number;
  totalSlippage: number;
  /** Peak-to-trough decline of the running realised-P&L curve, in currency. */
  maximumDrawdown: number;
  exitReasonCounts: Record<PaperTradeExitReason, number>;
}

export interface PaperTradeHistoryQueryRepository {
  list(input: ListPaperTradeHistoryInput): Promise<PaperTradeHistoryRecord[]>;
  listAccountNames(): Promise<Array<{ id: string; name: string }>>;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

/** The per-trade figures derived from a stored fill, with no look-ahead. */
export interface DerivedTradeOutcome {
  returnPercent: number | null;
  rewardMultiple: number | null;
  holdingMinutes: number | null;
}

/**
 * Derives one trade's realised return, reward multiple, and holding period.
 *
 * Reward is measured against the risk the trade accepted at entry
 * (`|entry - stop| x quantity`), which is the only risk figure knowable at the
 * moment of the fill. Each figure stays null when its inputs are missing rather
 * than collapsing to zero, because "no realised return yet" and "a flat return"
 * are different facts.
 */
export function deriveTradeOutcome(input: {
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  realizedPnl: number | null;
  openedAt: Date;
  closedAt: Date | null;
}): DerivedTradeOutcome {
  const entryNotional = input.entryPrice * input.quantity;
  const initialRisk = Math.abs(input.entryPrice - input.stopLoss) * input.quantity;
  return {
    returnPercent: input.realizedPnl === null || entryNotional <= 0
      ? null
      : (input.realizedPnl / entryNotional) * 100,
    rewardMultiple: input.realizedPnl === null || initialRisk <= 0
      ? null
      : input.realizedPnl / initialRisk,
    holdingMinutes: input.closedAt === null
      ? null
      : Math.max(0, Math.round((input.closedAt.getTime() - input.openedAt.getTime()) / 60_000)),
  };
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Summarises a set of history rows without touching the database.
 *
 * Only closed trades contribute to realised statistics: an open position has no
 * realised profit or loss, and counting an unrealised mark here would overstate
 * the ledger. Drawdown walks the closed trades in exit order, because a realised
 * equity curve is only defined at the moment each trade actually closes.
 */
export function summarizePaperTradeHistory(records: readonly PaperTradeHistoryRecord[]): PaperTradeHistorySummary {
  const closed = records
    .filter((record) => record.status === "CLOSED" && record.realizedPnl !== null)
    .sort((left, right) => (
      (left.closedAt?.getTime() ?? 0) - (right.closedAt?.getTime() ?? 0) || left.id.localeCompare(right.id)
    ));

  const profits = closed.map((record) => record.realizedPnl as number);
  const wins = profits.filter((value) => value > 0);
  const losses = profits.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));

  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const value of profits) {
    equity += value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }

  const exitReasonCounts: Record<PaperTradeExitReason, number> = {
    STOP_LOSS: 0,
    TARGET: 0,
    MANUAL: 0,
    CANCELLED: 0,
    EXPIRED: 0,
  };
  for (const record of records) {
    if (record.exitReason) {
      exitReasonCounts[record.exitReason] += 1;
    }
  }

  return {
    tradeCount: records.length,
    openTradeCount: records.filter((record) => record.status === "OPEN").length,
    closedTradeCount: closed.length,
    winningTradeCount: wins.length,
    losingTradeCount: losses.length,
    breakEvenTradeCount: profits.filter((value) => value === 0).length,
    winRatePercent: closed.length === 0 ? null : rounded(wins.length / closed.length * 100),
    grossProfit: rounded(grossProfit),
    grossLoss: rounded(grossLoss),
    netRealizedPnl: rounded(grossProfit - grossLoss),
    profitFactor: grossLoss === 0 ? null : rounded(grossProfit / grossLoss),
    expectancy: average(profits),
    averageWin: average(wins),
    averageLoss: average(losses),
    averageRewardMultiple: average(
      closed.map((record) => record.rewardMultiple).filter((value): value is number => value !== null),
    ),
    averageHoldingMinutes: average(
      closed.map((record) => record.holdingMinutes).filter((value): value is number => value !== null),
    ),
    largestWin: wins.length === 0 ? null : rounded(Math.max(...wins)),
    largestLoss: losses.length === 0 ? null : rounded(Math.min(...losses)),
    totalFees: rounded(records.reduce((sum, record) => sum + record.fees, 0)),
    totalSlippage: rounded(records.reduce((sum, record) => sum + record.slippage, 0)),
    maximumDrawdown: rounded(maximumDrawdown),
    exitReasonCounts,
  };
}
