export interface BacktestMetrics {
  totalTrades?: number;
  winningTrades?: number;
  losingTrades?: number;
  winRatePercent?: number;
  netPnl?: number;
  grossProfit?: number;
  grossLoss?: number;
  profitFactor?: number;
  maxDrawdownPercent?: number;
  maxDrawdownDurationDays?: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  averageTradePnl?: number;
  largestWinningTrade?: number;
  largestLosingTrade?: number;
}

export interface BacktestRunRow {
  id: string;
  strategyVersionId: string;
  instrumentSymbol?: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED" | string;
  timeframe: string;
  startedAt: string;
  completedAt?: string | null;
  dataWindowStart: string;
  dataWindowEnd: string;
  metrics?: BacktestMetrics | null;
  errorMessage?: string | null;
}

export interface BacktestTradeRow {
  id: string;
  instrumentId: string;
  side: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  returnPercent: number;
  exitReason: string;
  reasoning?: unknown;
}

export interface BacktestMonthlyPerformanceRow {
  monthStart: string;
  tradeCount: number;
  winningTradeCount: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  maxDrawdownPercent: number;
}

export interface BacktestRunDetails {
  run: BacktestRunRow;
  trades: BacktestTradeRow[];
  monthlyPerformance: BacktestMonthlyPerformanceRow[];
}
