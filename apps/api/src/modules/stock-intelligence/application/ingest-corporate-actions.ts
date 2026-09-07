import type { CorporateActionRecord } from "../domain/canonical.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import type { CorporateActionAdapter, DiscoveredCorporateAction } from "./corporate-action-adapter.js";

export interface IngestCorporateActionsResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly skippedExisting: number;
}

function toRecord(instrumentId: string, action: DiscoveredCorporateAction): Omit<CorporateActionRecord, "actionId"> {
  return {
    instrumentId,
    actionType: action.actionType,
    exDate: action.exDate,
    details: action.details,
    publishedAt: action.publishedAt,
    effectiveAt: action.effectiveAt,
    availableAt: action.availableAt,
  };
}

export class IngestCorporateActions {
  constructor(
    private readonly adapter: CorporateActionAdapter,
    private readonly store: StockIntelligenceStore,
  ) {}

  async execute(input: {
    instrumentId: string;
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<IngestCorporateActionsResult> {
    const fetched = await this.adapter.fetchActions(input);
    const existing = await this.store.listCorporateActionsAsOf(input.instrumentId, input.dataCutoff);
    const seen = new Set(existing.map((row) => `${row.actionType}|${row.exDate}`));
    let inserted = 0;
    let skippedExisting = 0;

    for (const action of fetched) {
      const key = `${action.actionType}|${action.exDate}`;
      if (seen.has(key)) {
        skippedExisting += 1;
        continue;
      }
      await this.store.insertCorporateAction(toRecord(input.instrumentId, action));
      seen.add(key);
      inserted += 1;
    }

    return { fetched: fetched.length, inserted, skippedExisting };
  }
}
