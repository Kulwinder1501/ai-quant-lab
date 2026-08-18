import type {
  OpenPaperTradeInput,
  OptionContractSpec,
  PaperTrade,
  PaperTradeRepository,
} from "../domain/paper-trading.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";
import { calculateEntryFees } from "../domain/brokerage-calculator.js";

export interface OpenPaperTradeRequest {
  accountId: string;
  tradeIdeaId: string;
  quantity: number;
  fillPrice: number;
  entryFees?: number;
  entrySlippage?: number;
  notes?: string;
  openedAt?: Date;
  orderType?: "MARKET" | "PENDING";
  /** When true (default), compute Zerodha options entry fees from premium × qty. */
  applyBrokerageFees?: boolean;
  stopLossOverride?: number;
  targetPriceOverride?: number;
  sideOverride?: TradeSide;
  feeBreakdown?: Record<string, unknown>;
  /** Persists strike/expiry/type/IV for live Black–Scholes mark-to-market. */
  optionContract?: OptionContractSpec;
  /** Regime observed at decision time. Research and audit only; nothing reads it back to trade. */
  regimeObservationId?: string | null;
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number.`);
  }
}

/** Accepts a proposal using a user-supplied, explicitly simulated fill price. */
export class OpenPaperTrade {
  constructor(private readonly paperTradeRepository: PaperTradeRepository) {}

  async execute(input: OpenPaperTradeRequest): Promise<PaperTrade> {
    assertPositiveFinite(input.quantity, "Quantity");
    assertPositiveFinite(input.fillPrice, "Fill price");
    const applyFees = input.applyBrokerageFees !== false;
    const entryBreakdown = applyFees ? calculateEntryFees(input.fillPrice, input.quantity) : null;
    const entryFees = input.entryFees ?? entryBreakdown?.total ?? 0;
    const entrySlippage = input.entrySlippage ?? 0;
    assertNonNegativeFinite(entryFees, "Entry fees");
    assertNonNegativeFinite(entrySlippage, "Entry slippage");
    const openedAt = input.openedAt ?? new Date();
    if (Number.isNaN(openedAt.getTime())) {
      throw new Error("Opened-at timestamp is invalid.");
    }
    const request: OpenPaperTradeInput = {
      accountId: input.accountId,
      tradeIdeaId: input.tradeIdeaId,
      quantity: input.quantity,
      fillPrice: input.fillPrice,
      openedAt,
      entryFees,
      entrySlippage,
      notes: input.notes?.trim() ?? "",
      status: input.orderType === "PENDING" ? "PENDING" : "OPEN",
      feeBreakdown: input.feeBreakdown ?? (entryBreakdown ? { entry: entryBreakdown } : undefined),
      stopLossOverride: input.stopLossOverride,
      targetPriceOverride: input.targetPriceOverride,
      sideOverride: input.sideOverride,
      optionContract: input.optionContract,
      regimeObservationId: input.regimeObservationId ?? null,
    };
    return this.paperTradeRepository.openFromTradeIdea(request);
  }
}
