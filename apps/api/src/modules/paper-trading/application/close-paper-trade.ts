import type { PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";

export interface ClosePaperTradeRequest {
  paperTradeId: string;
  exitPrice: number;
  exitFees?: number;
  exitSlippage?: number;
  notes?: string;
  closedAt?: Date;
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

/** Records a deliberate manual simulated exit. It cannot trigger a broker action. */
export class ClosePaperTrade {
  constructor(private readonly paperTradeRepository: PaperTradeRepository) {}

  async execute(input: ClosePaperTradeRequest): Promise<PaperTrade> {
    const trade = await this.paperTradeRepository.findOpenById(input.paperTradeId);
    if (!trade) {
      throw new Error(`Open paper trade ${input.paperTradeId} was not found.`);
    }
    assertPositiveFinite(input.exitPrice, "Exit price");
    const exitFees = input.exitFees ?? 0;
    const exitSlippage = input.exitSlippage ?? 0;
    assertNonNegativeFinite(exitFees, "Exit fees");
    assertNonNegativeFinite(exitSlippage, "Exit slippage");
    const closedAt = input.closedAt ?? new Date();
    if (Number.isNaN(closedAt.getTime()) || closedAt < trade.openedAt) {
      throw new Error("Closed-at timestamp must be on or after the simulated opening time.");
    }
    return this.paperTradeRepository.close({
      paperTradeId: trade.id,
      exitPrice: input.exitPrice,
      exitReason: "MANUAL",
      closedAt,
      exitFees,
      exitSlippage,
      details: { source: "MANUAL", notes: input.notes?.trim() ?? "" },
    });
  }
}
