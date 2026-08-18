import type { TradeIdeaStatus, TradeSide } from "../../strategy-engine/domain/strategy.js";

export type PaperTradeStatus = "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";
export type PaperTradeExitReason = "STOP_LOSS" | "TARGET" | "MANUAL" | "CANCELLED" | "EXPIRED" | "TRAP_DETECTED";
export type PaperTradeEventType =
  | "PENDING_PLACED"
  | "OPENED"
  | "STOP_LOSS_HIT"
  | "TARGET_HIT"
  | "MANUALLY_CLOSED"
  | "CANCELLED"
  | "EXPIRED"
  | "TRAP_DETECTED";
export type OptionContractType = "CE" | "PE";

export interface PaperAccount {
  id: string;
  name: string;
  openingBalance: number;
  currency: "INR";
  isActive: boolean;
}

export interface CreatePaperAccountInput {
  name: string;
  openingBalance: number;
}

export interface PaperAccountRepository {
  create(input: CreatePaperAccountInput): Promise<PaperAccount>;
  findById(id: string): Promise<PaperAccount | null>;
  findByName(name: string): Promise<PaperAccount | null>;
}

export interface PaperTrade {
  id: string;
  accountId: string;
  tradeIdeaId: string | null;
  instrumentId: string;
  instrumentSymbol?: string;
  timeframe: string | null;
  side: TradeSide;
  status: PaperTradeStatus;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  /** First instant at which the currently persisted stopLoss was active. */
  stopLossEffectiveAt?: Date;
  targetPrice: number;
  openedAt: Date;
  closedAt: Date | null;
  exitPrice: number | null;
  exitReason: PaperTradeExitReason | null;
  realizedPnl: number | null;
  /** Total simulated INR costs applied to this trade so far. */
  fees: number;
  /** Itemised entry/exit fee ledger (Zerodha/NSE options schedule). */
  feeBreakdown?: Record<string, unknown>;
  /** Total simulated INR slippage costs applied to this trade so far. */
  slippage: number;
  notes: string;
  /** Option-buyer contract fields; all null for legacy / non-option trades. */
  optionStrike?: number | null;
  optionExpiry?: Date | null;
  optionType?: OptionContractType | null;
  underlyingSymbol?: string | null;
  underlyingEntryPrice?: number | null;
  entryIv?: number | null;
  /**
   * The regime observed when this trade was opened, for research and audit only.
   *
   * Null means the observation was not recorded, never that the market had no regime. No execution
   * path reads this, and nothing must start: the moment a gate depends on it, an unrecorded
   * observation becomes a behaviour change rather than a gap in the record.
   */
  regimeObservationId?: string | null;
}

export interface PaperTradeEvent {
  id: string;
  paperTradeId: string;
  eventType: PaperTradeEventType;
  price: number | null;
  quantity: number | null;
  details: Record<string, unknown>;
  occurredAt: Date;
}

export interface OptionContractSpec {
  optionStrike: number;
  optionExpiry: Date;
  optionType: OptionContractType;
  underlyingSymbol: string;
  /**
   * Spot when the contract was bought, the anchor trap detection measures divergence from.
   *
   * Optional because "not known" is a real state and the honest encoding of it. The column is
   * already nullable and `decideOptionBuyerLiveExit` skips trap detection without an anchor,
   * so a position simply keeps its ordinary stop and target. Substituting something
   * spot-shaped instead — the strike, say — produces confident wrong exits.
   */
  underlyingEntryPrice?: number;
  entryIv: number;
}

export interface OpenPaperTradeInput {
  accountId: string;
  tradeIdeaId: string;
  quantity: number;
  /** Explicit simulated fill price. It is never sent to a broker. */
  fillPrice: number;
  openedAt: Date;
  entryFees: number;
  entrySlippage: number;
  notes: string;
  status?: PaperTradeStatus; // If "PENDING", trade waits to be filled
  /** Optional itemised entry fee ledger persisted on the trade. */
  feeBreakdown?: Record<string, unknown>;
  /**
   * Option-buyer fills store premium-space stop/target and are always LONG
   * (buying CE or PE). When set, these override the trade idea's index geometry.
   */
  stopLossOverride?: number;
  targetPriceOverride?: number;
  sideOverride?: TradeSide;
  /** When set, persists first-class option contract columns for live repricing. */
  optionContract?: OptionContractSpec;
  /** Result of the strict 11-factor options entry validation checklist. */
  optionsValidationResult?: Record<string, unknown>;
  /**
   * Regime observed at decision time, stamped for research. Optional by design: a caller that
   * cannot record an observation still opens the trade, unstamped.
   */
  regimeObservationId?: string | null;
}

export interface ClosePaperTradeInput {
  paperTradeId: string;
  exitPrice: number;
  exitReason: PaperTradeExitReason;
  closedAt: Date;
  exitFees: number;
  exitSlippage: number;
  details: Record<string, unknown>;
  /** Optional itemised exit fee ledger merged into fee_breakdown.exit. */
  feeBreakdown?: Record<string, unknown>;
}

export interface FillPendingTradeInput {
  paperTradeId: string;
  fillPrice: number;
  filledAt: Date;
}

export interface PaperTradeRepository {
  /** Atomically validates the active account/proposed idea and records an OPENED event. */
  openFromTradeIdea(input: OpenPaperTradeInput): Promise<PaperTrade>;
  findOpenById(id: string): Promise<PaperTrade | null>;
  listOpenByAccount(accountId: string): Promise<PaperTrade[]>;
  listPendingByAccount(accountId: string): Promise<PaperTrade[]>;
  /** Atomically closes an OPEN trade and records its corresponding exit event. */
  close(input: ClosePaperTradeInput): Promise<PaperTrade>;
  /** Fills a PENDING trade, moving it to OPEN. */
  fillPendingTrade(input: FillPendingTradeInput): Promise<PaperTrade>;
  updateStopLoss?(id: string, newStopLoss: number, reason?: string): Promise<void>;
  findAccountPerformanceData(accountId: string): Promise<PaperAccountPerformanceData | null>;
}

export interface PaperAccountPerformanceData {
  account: PaperAccount;
  closedTrades: PaperTrade[];
  openTrades: PaperTrade[];
  /** Cash capacity after realised P/L and currently reserved open-trade notional/costs. */
  availableCapital: number;
}

export interface TradeIdeaAcceptanceView {
  id: string;
  instrumentId: string;
  side: TradeSide;
  status: TradeIdeaStatus;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  expiresAt: Date | null;
}
