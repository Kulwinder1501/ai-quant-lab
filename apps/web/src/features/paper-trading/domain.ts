export interface PaperAccountSummary {
  id: string;
  name: string;
  openingBalance: number;
  currency: string;
  isActive: boolean;
}

export interface PaperTradeRow {
  id: string;
  accountId: string;
  instrumentId: string;
  instrumentSymbol?: string;
  instrumentName?: string;
  timeframe?: string;
  tradeIdeaId?: string | null;
  side: "BUY" | "SELL";
  status: "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";
  quantity: number;
  fillPrice: number;
  openedAt: string;
  entryFees: number;
  entrySlippage: number;
  exitPrice?: number | null;
  closedAt?: string | null;
  exitFees?: number | null;
  exitSlippage?: number | null;
  exitReason?: string | null;
  realizedPnl?: number | null;
  returnPercent?: number | null;
  notes?: string;
}

export interface PaperAccountFullSummary {
  account: PaperAccountSummary;
  openTrades: PaperTradeRow[];
  pendingTrades: PaperTradeRow[];
  closedTrades: PaperTradeRow[];
  metrics: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRatePercent: number;
    realizedPnl: number;
    unrealizedPnl: number;
    equity: number;
  };
}
