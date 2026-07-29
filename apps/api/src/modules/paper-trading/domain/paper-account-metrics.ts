import type { PaperAccountPerformanceData, PaperTrade } from "./paper-trading.js";

export interface PaperAccountMetrics {
  openingBalance: number;
  closedTradeCount: number;
  openTradeCount: number;
  winningTradeCount: number;
  winRatePercent: number;
  realizedPnl: number;
  totalFees: number;
  totalSlippage: number;
  averageReward: number | null;
  maximumDrawdownPercent: number;
  currentEquity: number;
  availableCapital: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function initialRisk(trade: PaperTrade): number {
  return Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
}

/** Calculates realised performance only; open trades remain excluded from equity until a later mark-to-market policy exists. */
export function calculatePaperAccountMetrics(data: PaperAccountPerformanceData): PaperAccountMetrics {
  const closed = [...data.closedTrades].sort((left, right) => (
    (left.closedAt?.getTime() ?? 0) - (right.closedAt?.getTime() ?? 0) || left.id.localeCompare(right.id)
  ));
  const realizedPnl = closed.reduce((sum, trade) => sum + (trade.realizedPnl ?? 0), 0);
  const totalFees = [...closed, ...data.openTrades].reduce((sum, trade) => sum + trade.fees, 0);
  const totalSlippage = [...closed, ...data.openTrades].reduce((sum, trade) => sum + trade.slippage, 0);
  const winningTradeCount = closed.filter((trade) => (trade.realizedPnl ?? 0) > 0).length;
  const rewards = closed
    .filter((trade) => trade.realizedPnl !== null && initialRisk(trade) > 0)
    .map((trade) => (trade.realizedPnl as number) / initialRisk(trade));

  let equity = data.account.openingBalance;
  let peak = equity;
  let maximumDrawdownPercent = 0;
  for (const trade of closed) {
    equity += trade.realizedPnl ?? 0;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maximumDrawdownPercent = Math.max(maximumDrawdownPercent, (peak - equity) / peak * 100);
    }
  }

  return {
    openingBalance: data.account.openingBalance,
    closedTradeCount: closed.length,
    openTradeCount: data.openTrades.length,
    winningTradeCount,
    winRatePercent: closed.length === 0 ? 0 : rounded(winningTradeCount / closed.length * 100),
    realizedPnl: rounded(realizedPnl),
    totalFees: rounded(totalFees),
    totalSlippage: rounded(totalSlippage),
    averageReward: rewards.length === 0 ? null : rounded(rewards.reduce((sum, value) => sum + value, 0) / rewards.length),
    maximumDrawdownPercent: rounded(maximumDrawdownPercent),
    currentEquity: rounded(data.account.openingBalance + realizedPnl),
    availableCapital: rounded(data.availableCapital),
  };
}
