import type {
  ExecuteExitSliceInput,
  PaperTrade,
  PaperTradeRepository,
} from "../domain/paper-trading.js";

export interface PartialExitPaperTradeInput extends ExecuteExitSliceInput {}

export class PartialExitPaperTrade {
  constructor(private readonly paperTradeRepository: PaperTradeRepository) {}

  async execute(input: PartialExitPaperTradeInput): Promise<PaperTrade> {
    return this.paperTradeRepository.executeExitSlice(input);
  }
}
