import { asNumber, asObject, asString, objectAt } from "../research/json";
import type {
  TradeHistoryAccount,
  TradeHistoryExitReason,
  TradeHistoryPage,
  TradeHistoryRecord,
  TradeHistorySide,
  TradeHistoryStatus,
  TradeHistorySummary,
} from "./domain";

const statuses: readonly TradeHistoryStatus[] = ["OPEN", "CLOSED", "CANCELLED"];
const sides: readonly TradeHistorySide[] = ["LONG", "SHORT"];
const exitReasons: readonly TradeHistoryExitReason[] = [
  "STOP_LOSS",
  "TARGET",
  "MANUAL",
  "CANCELLED",
  "MOMENTUM_STALL",
  "RUNNER_TRAIL",
  "T1_TARGET",
  "T2_TARGET",
  "TRAP_DETECTED",
  "EXPIRED",
];

function member<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const text = asString(value);
  return text && (allowed as readonly string[]).includes(text) ? text as T : null;
}

function numberOrZero(value: unknown): number {
  return asNumber(value) ?? 0;
}

export function parseTradeHistoryRecord(value: unknown): TradeHistoryRecord | null {
  const record = asObject(value);
  if (!record) return null;
  const id = asString(record.id);
  const symbol = asString(record.instrumentSymbol);
  const side = member(record.side, sides);
  const status = member(record.status, statuses);
  // A row that cannot prove it is a simulation record is not rendered at all.
  if (!id || !symbol || !side || !status || record.simulatedOnly !== true) return null;

  return {
    simulatedOnly: true,
    id,
    accountId: asString(record.accountId) ?? "",
    accountName: asString(record.accountName) ?? "Unnamed account",
    instrumentSymbol: symbol,
    instrumentName: asString(record.instrumentName),
    timeframe: asString(record.timeframe),
    tradeIdeaId: asString(record.tradeIdeaId),
    side,
    status,
    quantity: asNumber(record.quantity),
    entryPrice: asNumber(record.entryPrice),
    stopLoss: asNumber(record.stopLoss),
    targetPrice: asNumber(record.targetPrice),
    openedAt: asString(record.openedAt),
    closedAt: asString(record.closedAt),
    exitPrice: asNumber(record.exitPrice),
    exitReason: member(record.exitReason, exitReasons),
    realizedPnl: asNumber(record.realizedPnl),
    returnPercent: asNumber(record.returnPercent),
    rewardMultiple: asNumber(record.rewardMultiple),
    holdingMinutes: asNumber(record.holdingMinutes),
    fees: asNumber(record.fees),
    slippage: asNumber(record.slippage),
    notes: asString(record.notes) ?? "",
    optionType: record.optionType === "CE" || record.optionType === "PE" ? record.optionType : null,
    optionStrike: asNumber(record.optionStrike),
    underlyingSymbol: asString(record.underlyingSymbol),
  };
}

export function parseTradeHistorySummary(value: unknown): TradeHistorySummary {
  const summary = asObject(value) ?? {};
  const exitReasonCounts = objectAt(summary, "exitReasonCounts");
  return {
    tradeCount: numberOrZero(summary.tradeCount),
    openTradeCount: numberOrZero(summary.openTradeCount),
    closedTradeCount: numberOrZero(summary.closedTradeCount),
    winningTradeCount: numberOrZero(summary.winningTradeCount),
    losingTradeCount: numberOrZero(summary.losingTradeCount),
    breakEvenTradeCount: numberOrZero(summary.breakEvenTradeCount),
    winRatePercent: asNumber(summary.winRatePercent),
    grossProfit: numberOrZero(summary.grossProfit),
    grossLoss: numberOrZero(summary.grossLoss),
    netRealizedPnl: numberOrZero(summary.netRealizedPnl),
    profitFactor: asNumber(summary.profitFactor),
    expectancy: asNumber(summary.expectancy),
    averageWin: asNumber(summary.averageWin),
    averageLoss: asNumber(summary.averageLoss),
    averageRewardMultiple: asNumber(summary.averageRewardMultiple),
    averageHoldingMinutes: asNumber(summary.averageHoldingMinutes),
    largestWin: asNumber(summary.largestWin),
    largestLoss: asNumber(summary.largestLoss),
    totalFees: numberOrZero(summary.totalFees),
    totalSlippage: numberOrZero(summary.totalSlippage),
    maximumDrawdown: numberOrZero(summary.maximumDrawdown),
    exitReasonCounts: {
      STOP_LOSS: numberOrZero(exitReasonCounts.STOP_LOSS),
      TARGET: numberOrZero(exitReasonCounts.TARGET),
      MANUAL: numberOrZero(exitReasonCounts.MANUAL),
      CANCELLED: numberOrZero(exitReasonCounts.CANCELLED),
      MOMENTUM_STALL: numberOrZero(exitReasonCounts.MOMENTUM_STALL),
      RUNNER_TRAIL: numberOrZero(exitReasonCounts.RUNNER_TRAIL),
      T1_TARGET: numberOrZero(exitReasonCounts.T1_TARGET),
      T2_TARGET: numberOrZero(exitReasonCounts.T2_TARGET),
      TRAP_DETECTED: numberOrZero(exitReasonCounts.TRAP_DETECTED),
      EXPIRED: numberOrZero(exitReasonCounts.EXPIRED),
    },
  };
}

function parseAccount(value: unknown): TradeHistoryAccount | null {
  const account = asObject(value);
  const id = account && asString(account.id);
  if (!account || !id) return null;
  return { id, name: asString(account.name) ?? "Unnamed account" };
}

export function parseTradeHistoryEnvelope(value: unknown): TradeHistoryPage {
  const payload = asObject(value) ?? {};
  const page = objectAt(payload, "page");
  const context = objectAt(payload, "context");
  return {
    records: Array.isArray(payload.data)
      ? payload.data.map(parseTradeHistoryRecord).filter((record): record is TradeHistoryRecord => record !== null)
      : [],
    summary: parseTradeHistorySummary(payload.summary),
    accounts: Array.isArray(context.accounts)
      ? context.accounts.map(parseAccount).filter((account): account is TradeHistoryAccount => account !== null)
      : [],
    limit: numberOrZero(page.limit),
    truncated: page.truncated === true,
  };
}
