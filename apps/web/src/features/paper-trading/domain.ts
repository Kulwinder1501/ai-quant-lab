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
  /**
   * The strategy that produced this trade, from the data.
   *
   * Absent means the lineage could not be resolved, and must be rendered as unknown. The positions
   * table used to derive this from the timeframe, so a 5m Sniper position from
   * `momentum-scalp-pattern` was labelled `trend-breakout` -- a strategy that is TERMINAL_UNOWNED
   * and traded by no bot. An invented attribution is worse than an absent one: nothing
   * distinguishes it from a real one.
   */
  strategyKey?: string | null;
  strategyName?: string | null;
  tradeIdeaId?: string | null;
  side: "BUY" | "SELL" | "LONG" | "SHORT";
  status: "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";
  quantity: number;
  fillPrice: number;
  entryPrice?: number;
  stopLoss?: number;
  targetPrice?: number;
  openedAt: string;
  entryFees: number;
  /** Entry plus exit. `entryFees` is the entry leg alone. */
  totalFees?: number;
  entrySlippage: number;
  feeBreakdown?: Record<string, unknown>;
  exitPrice?: number | null;
  closedAt?: string | null;
  exitFees?: number | null;
  exitSlippage?: number | null;
  exitReason?: string | "TRAP_DETECTED" | null;
  realizedPnl?: number | null;
  returnPercent?: number | null;
  notes?: string;
  optionStrike?: number | null;
  optionExpiry?: string | null;
  optionType?: "CE" | "PE" | null;
  underlyingSymbol?: string | null;
  entryIv?: number | null;
  liveValuation?: PaperTradeLiveValuation;
}

export interface PaperTradeLiveValuation {
  status: "AVAILABLE" | "UNAVAILABLE";
  /**
   * `OPTION_CHAIN_MID` is a price the market was quoting; `OPTION_MODEL` is this project's
   * estimate of one, used only where no snapshot covers the contract.
   */
  source: "OPTION_CHAIN_MID" | "OPTION_MODEL" | "UNDERLYING_SPOT" | "UNAVAILABLE";
  markPrice: number | null;
  underlyingPrice: number | null;
  unrealizedPnl: number | null;
  returnPercent: number | null;
  asOf: string;
  volatility: number | null;
  /** `CHAIN_IMPLIED` is solved from the observed mid, so it needs no external vol input. */
  volatilitySource: "CHAIN_IMPLIED" | "INDIA_VIX" | "ENTRY_IV" | null;
  /**
   * Per contract, at the same volatility the mark used. Null for a spot-marked position,
   * which has no option contract — reporting delta 1 there would imply an option-like
   * exposure the row does not represent.
   */
  greeks: PaperTradeGreeks | null;
  daysToExpiry: number | null;
  reason: string | null;
}

export interface PaperTradeGreeks {
  delta: number;
  gamma: number;
  /** Currency per calendar day, negative for a long option: the buyer pays theta. */
  theta: number;
  /** Per one absolute percentage point of IV. */
  vega: number;
}

export function isLongTradeSide(side: PaperTradeRow["side"]): boolean {
  return side === "LONG" || side === "BUY";
}

export function isOptionPaperTrade(trade: PaperTradeRow): boolean {
  return trade.optionStrike != null
    && typeof trade.optionExpiry === "string"
    && (trade.optionType === "CE" || trade.optionType === "PE")
    && typeof trade.underlyingSymbol === "string"
    && trade.underlyingSymbol.length > 0;
}

export function paperTradeContractLabel(trade: PaperTradeRow): string {
  if (!isOptionPaperTrade(trade)) return trade.instrumentSymbol || "NIFTY50";
  return `${trade.underlyingSymbol} ${trade.optionStrike} ${trade.optionType}`;
}

/**
 * The account metrics the API returns (`calculatePaperAccountMetrics`).
 *
 * This page used to type them as `totalTrades / unrealizedPnl / equity`, names the API never sent, so
 * Total Equity and Unrealized P&L rendered `NaN`. `currentEquity` is the opening balance plus REALISED
 * P&L only; open positions are marked per trade (`liveValuation`), so a live equity adds them on top.
 */
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

export interface PaperAccountFullSummary {
  account: PaperAccountSummary;
  openTrades: PaperTradeRow[];
  pendingTrades: PaperTradeRow[];
  closedTrades: PaperTradeRow[];
  metrics: PaperAccountMetrics;
}

/** Unrealised P&L across the open trades that have a live mark, and how many do not. */
export function summariseOpenTradeMarks(openTrades: PaperTradeRow[]): { unrealizedPnl: number; unmarkedCount: number } {
  let unrealizedPnl = 0;
  let unmarkedCount = 0;
  for (const trade of openTrades) {
    const pnl = trade.liveValuation?.status === "AVAILABLE" ? trade.liveValuation.unrealizedPnl : null;
    if (pnl === null || pnl === undefined || !Number.isFinite(pnl)) {
      unmarkedCount += 1;
    } else {
      unrealizedPnl += pnl;
    }
  }
  return { unrealizedPnl, unmarkedCount };
}

/** A limit order's own terms, kept on the trade by the API (`fee_breakdown.order`). Null for any other trade. */
export interface LimitOrderInfo {
  limitPrice: number;
  /** The ask when the order was placed. Zero when the order predates the field. */
  placedAsk: number;
  validUntil: string;
}

export function limitOrderInfo(trade: PaperTradeRow): LimitOrderInfo | null {
  const order = trade.feeBreakdown?.order;
  if (!order || typeof order !== "object") return null;
  const meta = order as Record<string, unknown>;
  if (meta.type !== "LIMIT" || typeof meta.limitPrice !== "number" || typeof meta.validUntil !== "string") return null;
  return {
    limitPrice: meta.limitPrice,
    placedAsk: typeof meta.placedAsk === "number" ? meta.placedAsk : 0,
    validUntil: meta.validUntil,
  };
}
