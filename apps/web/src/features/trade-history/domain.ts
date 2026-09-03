import { isTimestampOnIstDate } from "../../lib/ist-date";

/** Read-only view types for the simulated-trade ledger served by GET /paper-trades. */

export type TradeHistoryStatus = "OPEN" | "CLOSED" | "CANCELLED";
export type TradeHistorySide = "LONG" | "SHORT";
export type TradeHistoryExitReason =
  | "STOP_LOSS"
  | "TARGET"
  | "MANUAL"
  | "CANCELLED"
  | "MOMENTUM_STALL"
  | "RUNNER_TRAIL"
  | "T1_TARGET"
  | "T2_TARGET"
  | "TRAP_DETECTED"
  | "EXPIRED"
  // The 15:15 IST intraday square-off. Absent from this union, `member()` maps it to null and the
  // ledger reports a closed trade with no exit reason at all.
  | "SESSION_CLOSE";
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
  /**
   * The option contract, when the row is one.
   *
   * `side` is LONG on every option position because the bot only buys, so it cannot separate a
   * call from a put. These carry the identity the ledger shows in its place.
   */
  optionType: "CE" | "PE" | null;
  optionStrike: number | null;
  underlyingSymbol: string | null;
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

export type TradeHistoryMode = "all" | "scalp" | "swing";

export interface TradeHistoryFilters {
  accountId: string;
  instrumentSymbol: string;
  timeframe: string;
  date: string;
  status: TradeHistoryStatus | "ALL";
  side: TradeHistorySide | "ALL";
  exitReason: TradeHistoryExitReason | "ALL";
  outcome: TradeOutcomeFilter | "ALL";
  limit: number;
}

export const defaultTradeHistoryFilters: TradeHistoryFilters = {
  accountId: "ALL",
  instrumentSymbol: "",
  timeframe: "ALL",
  date: "",
  status: "ALL",
  side: "ALL",
  exitReason: "ALL",
  outcome: "ALL",
  limit: 100,
};

const rounded = (value: number): number => Number(value.toFixed(6));

const average = (values: number[]): number | null => (
  values.length === 0 ? null : rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
);

/**
 * Scalp trades are generated from intraday scalping strategies (1m, 3m, 5m, 15m).
 * Swing trades represent higher timeframe or positional holds (1d, etc.).
 */
export function isTradeInMode(record: TradeHistoryRecord, mode: TradeHistoryMode): boolean {
  if (mode === "all") return true;
  const tf = record.timeframe?.trim().toLowerCase() ?? "";
  const minuteMatch = /^(\d+)m$/.exec(tf);
  const isScalp = (minuteMatch !== null && Number(minuteMatch[1]) <= 15)
    || (tf === "" && record.notes?.toLowerCase().includes("scalp"));
  return mode === "scalp" ? isScalp : !isScalp;
}

/** Matches trade record against selected single-date filter (YYYY-MM-DD). */
export function isTradeOnDate(record: TradeHistoryRecord, dateFilter: string): boolean {
  if (!dateFilter || !dateFilter.trim()) return true;
  const target = dateFilter.trim();
  return isTimestampOnIstDate(record.openedAt, target) || isTimestampOnIstDate(record.closedAt, target);
}

/** Matches trade record against selected timeframe filter (e.g. 1m, 3m, 5m, 15m, 1d). */
export function isTradeInTimeframe(record: TradeHistoryRecord, timeframeFilter: string): boolean {
  if (!timeframeFilter || timeframeFilter === "ALL") return true;
  const tf = record.timeframe?.trim().toLowerCase() ?? "";
  return tf === timeframeFilter.trim().toLowerCase();
}

const standardTradeHistoryTimeframes = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"] as const;

function timeframeDurationMinutes(timeframe: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe);
  if (!match) return Number.POSITIVE_INFINITY;
  const amount = Number(match[1]);
  return amount * (match[2] === "d" ? 1440 : match[2] === "h" ? 60 : 1);
}

/** Standard choices plus any legacy timeframe actually present in the ledger. */
export function listTradeHistoryTimeframes(records: readonly TradeHistoryRecord[]): string[] {
  const timeframes = new Set<string>(standardTradeHistoryTimeframes);
  for (const record of records) {
    const timeframe = record.timeframe?.trim().toLowerCase();
    if (timeframe) timeframes.add(timeframe);
  }
  return [...timeframes].sort((left, right) => (
    timeframeDurationMinutes(left) - timeframeDurationMinutes(right) || left.localeCompare(right)
  ));
}

/** Rebuilds the summary after the Swing/Scalp partition has been applied. */
export function summarizeTradeHistory(records: readonly TradeHistoryRecord[]): TradeHistorySummary {
  const closed = records
    .filter((record) => record.status === "CLOSED" && record.realizedPnl !== null)
    .sort((left, right) => {
      const leftClosedAt = left.closedAt ? Date.parse(left.closedAt) : 0;
      const rightClosedAt = right.closedAt ? Date.parse(right.closedAt) : 0;
      const safeLeft = Number.isNaN(leftClosedAt) ? 0 : leftClosedAt;
      const safeRight = Number.isNaN(rightClosedAt) ? 0 : rightClosedAt;
      return safeLeft - safeRight || left.id.localeCompare(right.id);
    });

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

  const exitReasonCounts: Record<TradeHistoryExitReason, number> = {
    STOP_LOSS: 0,
    TARGET: 0,
    MANUAL: 0,
    CANCELLED: 0,
    MOMENTUM_STALL: 0,
    SESSION_CLOSE: 0,
    RUNNER_TRAIL: 0,
    T1_TARGET: 0,
    T2_TARGET: 0,
    TRAP_DETECTED: 0,
    EXPIRED: 0,
  };
  for (const record of records) {
    if (record.exitReason) exitReasonCounts[record.exitReason] += 1;
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
    totalFees: rounded(records.reduce((sum, record) => sum + (record.fees ?? 0), 0)),
    totalSlippage: rounded(records.reduce((sum, record) => sum + (record.slippage ?? 0), 0)),
    maximumDrawdown: rounded(maximumDrawdown),
    exitReasonCounts,
  };
}

/** Turns the UI filter state into a query string the read-only endpoint accepts. */
export function tradeHistoryQuery(filters: TradeHistoryFilters): string {
  const parameters = new URLSearchParams();
  if (filters.accountId !== "ALL") parameters.set("accountId", filters.accountId);
  if (filters.instrumentSymbol.trim()) parameters.set("instrument", filters.instrumentSymbol.trim().toUpperCase());
  if (filters.status !== "ALL") parameters.set("status", filters.status);
  if (filters.side !== "ALL") parameters.set("side", filters.side);
  if (filters.exitReason !== "ALL") parameters.set("exitReason", filters.exitReason);
  if (filters.outcome !== "ALL") parameters.set("outcome", filters.outcome);
  if (filters.date && filters.date.trim()) parameters.set("date", filters.date.trim());
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
