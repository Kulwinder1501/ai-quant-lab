import { combineGate7Reports, type Gate7AcceptanceReport } from "../domain/gate7.js";
import { stockIntelligenceHorizons } from "../domain/data-quality.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { EvaluateGate7 } from "./evaluate-gate7.js";

export class RunGate7Acceptance {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    jobId: string;
    evaluationAsOf: Date;
  }): Promise<Gate7AcceptanceReport> {
    const evaluator = new EvaluateGate7(this.store);
    const reports = [];
    for (const horizon of stockIntelligenceHorizons) {
      const report = await evaluator.execute({
        jobId: input.jobId,
        evaluationAsOf: input.evaluationAsOf,
        horizon,
      });
      await this.store.insertGate7Report(report);
      reports.push(report);
    }
    return combineGate7Reports(reports);
  }
}
