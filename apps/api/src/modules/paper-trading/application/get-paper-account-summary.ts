import { calculatePaperAccountMetrics, type PaperAccountMetrics } from "../domain/paper-account-metrics.js";
import type { PaperTradeRepository } from "../domain/paper-trading.js";

/** Reports realised simulated performance and reserved capital without mark-to-market assumptions. */
export class GetPaperAccountSummary {
  constructor(private readonly paperTradeRepository: PaperTradeRepository) {}

  async execute(accountId: string): Promise<PaperAccountMetrics> {
    const performance = await this.paperTradeRepository.findAccountPerformanceData(accountId);
    if (!performance) {
      throw new Error(`Paper account ${accountId} was not found.`);
    }
    return calculatePaperAccountMetrics(performance);
  }
}
