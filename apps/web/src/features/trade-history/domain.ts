/** Read-only view types for the simulated-trade ledger served by GET /paper-trades. */

export type TradeHistoryStatus = "OPEN" | "CLOSED" | "CANCELLED";
export type TradeHistorySide = "LONG" | "SHORT";
export type TradeHistoryExitReason = "STOP_LOSS" | "TARGET" | "MANUAL" | "CANCELLED";
export type TradeOutcomeFilter = "WIN" | "LOSS" | "BREAK_EVEN";

export interface TradeHistoryRecord {
  /** Every row is a local simulation record, never a real or routable order. */
  simulatedOnly: true;
  id: string;
  accountId: string;
  accountName: string;
  instrumentSymbol: string;
  instrumentName: string | null;
  timeframe: string | null;
  tradeIdeaId: string | null;
  side: TradeHistorySide;
  status: TradeHistoryStatus;
  quantity: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  openedAt: string | null;
  closedAt: string | null;
  exitPrice: number | null;
  exitReason: TradeHistoryExitReason | null;
  realizedPnl: number | null;
  returnPercent: number | null;
  rewardMultiple: number | null;
  holdingMinutes: number | null;
  fees: number | null;
  slippage: number | null;
  notes: string;
}

export interface TradeHistorySummary {
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
  profitFactor: number | null;
  expectancy: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageRewardMultiple: number | null;
  averageHoldingMinutes: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  totalFees: number;
  totalSlippage: number;
  maximumDrawdown: number;
  exitReasonCounts: Record<TradeHistoryExitReason, number>;
}

export interface TradeHistoryAccount {
  id: string;
  name: string;
}

export interface TradeHistoryPage {
  records: TradeHistoryRecord[];
  summary: TradeHistorySummary;
  accounts: TradeHistoryAccount[];
  limit: number;
  /** True when the ledger was cut short by the requested limit. */
  truncated: boolean;
}

export interface TradeHistoryFilters {
  accountId: string;
  instrumentSymbol: string;
  status: TradeHistoryStatus | "ALL";
  side: TradeHistorySide | "ALL";
  exitReason: TradeHistoryExitReason | "ALL";
  outcome: TradeOutcomeFilter | "ALL";
  limit: number;
}

export const defaultTradeHistoryFilters: TradeHistoryFilters = {
  accountId: "ALL",
  instrumentSymbol: "",
  status: "ALL",
  side: "ALL",
  exitReason: "ALL",
  outcome: "ALL",
  limit: 100,
};

/** Turns the UI filter state into a query string the read-only endpoint accepts. */
export function tradeHistoryQuery(filters: TradeHistoryFilters): string {
  const parameters = new URLSearchParams();
  if (filters.accountId !== "ALL") parameters.set("accountId", filters.accountId);
  if (filters.instrumentSymbol.trim()) parameters.set("instrument", filters.instrumentSymbol.trim().toUpperCase());
  if (filters.status !== "ALL") parameters.set("status", filters.status);
  if (filters.side !== "ALL") parameters.set("side", filters.side);
  if (filters.exitReason !== "ALL") parameters.set("exitReason", filters.exitReason);
  if (filters.outcome !== "ALL") parameters.set("outcome", filters.outcome);
  parameters.set("limit", String(filters.limit));
  return `/paper-trades?${parameters.toString()}`;
}

/** A compact "2d 4h" style label for a holding period given in whole minutes. */
export function formatHoldingPeriod(minutes: number | null): string {
  if (minutes === null) return "Still open";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
