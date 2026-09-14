import { toCanonicalExtractedFact, type ExtractedFactDraft } from "../domain/extraction.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export class RecordExtractedFacts {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    drafts: readonly ExtractedFactDraft[];
    dataCutoff: Date;
  }): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const draft of input.drafts) {
      const record = toCanonicalExtractedFact(draft, input.dataCutoff);
      await this.store.insertFact(record);
      inserted += 1;
    }
    return { inserted };
  }
}
