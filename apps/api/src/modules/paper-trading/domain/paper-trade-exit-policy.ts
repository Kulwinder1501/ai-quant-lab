import type { PaperTrade, PaperTradeEventType, PaperTradeExitReason } from "./paper-trading.js";

export interface CompletedPriceCandle {
  id: string;
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ExitFillRule = "OPEN_GAP_STOP" | "OPEN_GAP_TARGET" | "INTRABAR_STOP" | "INTRABAR_TARGET" | "CONSERVATIVE_STOP_FIRST" | "TRAP_DETECTED";

export interface PaperTradeExitDecision {
  reason: Extract<PaperTradeExitReason, "STOP_LOSS" | "TARGET" | "TRAP_DETECTED">;
  eventType: Extract<PaperTradeEventType, "STOP_LOSS_HIT" | "TARGET_HIT" | "TRAP_DETECTED">;
  exitPrice: number;
  fillRule: ExitFillRule;
  candleId: string;
}

function stopDecision(candle: CompletedPriceCandle, exitPrice: number, fillRule: Extract<ExitFillRule, "OPEN_GAP_STOP" | "INTRABAR_STOP" | "CONSERVATIVE_STOP_FIRST">): PaperTradeExitDecision {
  return { reason: "STOP_LOSS", eventType: "STOP_LOSS_HIT", exitPrice, fillRule, candleId: candle.id };
}

function targetDecision(candle: CompletedPriceCandle, exitPrice: number, fillRule: Extract<ExitFillRule, "OPEN_GAP_TARGET" | "INTRABAR_TARGET">): PaperTradeExitDecision {
  return { reason: "TARGET", eventType: "TARGET_HIT", exitPrice, fillRule, candleId: candle.id };
}

/**
 * Resolve only information knowable from one completed OHLC candle. A gap at
 * the open is deterministically executable at that opening price. When both
 * protective levels occur intrabar and ordering is unknowable, stop wins.
 */
export function decidePaperTradeExit(trade: PaperTrade, candle: CompletedPriceCandle): PaperTradeExitDecision | null {
  if (trade.status !== "OPEN") {
    throw new Error("Only open paper trades can be evaluated for exits.");
  }
  if (trade.side === "LONG") {
    if (candle.open <= trade.stopLoss) return stopDecision(candle, candle.open, "OPEN_GAP_STOP");
    if (candle.open >= trade.targetPrice) return targetDecision(candle, candle.open, "OPEN_GAP_TARGET");
    const hitStop = candle.low <= trade.stopLoss;
    const hitTarget = candle.high >= trade.targetPrice;
    if (hitStop && hitTarget) return stopDecision(candle, trade.stopLoss, "CONSERVATIVE_STOP_FIRST");
    if (hitStop) return stopDecision(candle, trade.stopLoss, "INTRABAR_STOP");
    if (hitTarget) return targetDecision(candle, trade.targetPrice, "INTRABAR_TARGET");
    return null;
  }

  if (candle.open >= trade.stopLoss) return stopDecision(candle, candle.open, "OPEN_GAP_STOP");
  if (candle.open <= trade.targetPrice) return targetDecision(candle, candle.open, "OPEN_GAP_TARGET");
  const hitStop = candle.high >= trade.stopLoss;
  const hitTarget = candle.low <= trade.targetPrice;
  if (hitStop && hitTarget) return stopDecision(candle, trade.stopLoss, "CONSERVATIVE_STOP_FIRST");
  if (hitStop) return stopDecision(candle, trade.stopLoss, "INTRABAR_STOP");
  if (hitTarget) return targetDecision(candle, trade.targetPrice, "INTRABAR_TARGET");
  return null;
}

export function calculatePaperTradeNetPnl(input: {
  side: PaperTrade["side"];
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  totalFees: number;
  totalSlippage: number;
}): number {
  const gross = input.side === "LONG"
    ? (input.exitPrice - input.entryPrice) * input.quantity
    : (input.entryPrice - input.exitPrice) * input.quantity;
  return Number((gross - input.totalFees - input.totalSlippage).toFixed(6));
}
