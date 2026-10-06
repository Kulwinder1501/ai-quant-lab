import type {
  BacktestMetrics,
  BacktestMonthlyPerformance,
  BacktestTrade,
} from "./backtesting.js";

export interface BacktestCounters {
  signalCount: number;
  skippedSignalsNoNextCandle: number;
  skippedSignalsWhilePositionOpen: number;
  skippedSignalsInvalidGap: number;
  skippedSignalsInsufficientCapital: number;
  skippedSignalsUnsizable: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function orderedTrades(trades: readonly BacktestTrade[]): BacktestTrade[] {
  return [...trades].sort((left, right) => (
    left.exitTime.getTime() - right.exitTime.getTime()
    || left.entryTime.getTime() - right.entryTime.getTime()
    || left.instrumentId.localeCompare(right.instrumentId)
  ));
}

/** Builds realised run metrics from net trade P/L in deterministic exit order. */
export function calculateBacktestMetrics(
  trades: readonly BacktestTrade[],
  initialCapital: number,
  counters: BacktestCounters,
): BacktestMetrics {
  const ordered = orderedTrades(trades);
  const grossProfit = ordered.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = ordered.reduce((sum, trade) => sum + Math.max(0, -trade.pnl), 0);
  const netPnl = ordered.reduce((sum, trade) => sum + trade.pnl, 0);
  const winningTradeCount = ordered.filter((trade) => trade.pnl > 0).length;
  let equity = initialCapital;
  let peak = equity;
  let maximumDrawdownPercent = 0;
  for (const trade of ordered) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maximumDrawdownPercent = Math.max(maximumDrawdownPercent, (peak - equity) / peak * 100);
    }
  }
  const tradeCount = ordered.length;
  const winRatePercent = tradeCount === 0 ? 0 : winningTradeCount / tradeCount * 100;
  return {
    ...counters,
    tradeCount,
    winningTradeCount,
    losingTradeCount: ordered.filter((trade) => trade.pnl < 0).length,
    winRatePercent: rounded(winRatePercent),
    accuracyPercent: rounded(winRatePercent),
    grossProfit: rounded(grossProfit),
    grossLoss: rounded(grossLoss),
    netPnl: rounded(netPnl),
    profitFactor: grossLoss === 0 ? null : rounded(grossProfit / grossLoss),
    expectancy: rounded(tradeCount === 0 ? 0 : netPnl / tradeCount),
    maximumDrawdownPercent: rounded(maximumDrawdownPercent),
    endingEquity: rounded(initialCapital + netPnl),
  };
}

/** Computes within-month drawdown from each month's starting realised equity. */
export function calculateMonthlyPerformance(
  trades: readonly BacktestTrade[],
  initialCapital: number,
): BacktestMonthlyPerformance[] {
  const groups = new Map<string, { month: Date; trades: BacktestTrade[] }>();
  for (const trade of orderedTrades(trades)) {
    const month = monthStart(trade.exitTime);
    const key = month.toISOString();
    const group = groups.get(key) ?? { month, trades: [] };
    group.trades.push(trade);
    groups.set(key, group);
  }

  let realisedEquity = initialCapital;
  return [...groups.values()].sort((left, right) => left.month.getTime() - right.month.getTime()).map((group) => {
    let equity = realisedEquity;
    let peak = equity;
    let maxDrawdown = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let netPnl = 0;
    let winningTradeCount = 0;
    for (const trade of group.trades) {
      grossProfit += Math.max(0, trade.pnl);
      grossLoss += Math.max(0, -trade.pnl);
      netPnl += trade.pnl;
      if (trade.pnl > 0) winningTradeCount += 1;
      equity += trade.pnl;
      peak = Math.max(peak, equity);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    }
    realisedEquity = equity;
    return {
      monthStart: group.month,
      tradeCount: group.trades.length,
      winningTradeCount,
      grossProfit: rounded(grossProfit),
      grossLoss: rounded(grossLoss),
      netPnl: rounded(netPnl),
      maxDrawdownPercent: rounded(maxDrawdown),
    };
  });
}
