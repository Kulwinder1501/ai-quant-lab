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
