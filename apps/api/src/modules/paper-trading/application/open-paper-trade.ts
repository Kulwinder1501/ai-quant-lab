import type { OpenPaperTradeInput, PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";

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
    const entryFees = input.entryFees ?? 0;
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
    };
    return this.paperTradeRepository.openFromTradeIdea(request);
  }
}
