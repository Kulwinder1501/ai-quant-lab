import type { CanonicalRawRecord } from "../domain/canonical.js";
import {
  marketBarFromRaw,
  rawPayloadFromMarketBar,
  YAHOO_DAILY_BAR_SOURCE_KIND,
  type MarketDataAdapter,
} from "../domain/adapters.js";
import { STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION } from "../domain/versions.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { YAHOO_MAPPED_SYMBOLS } from "../../market-data/domain/yahoo-symbol-resolver.js";

export interface IngestMarketBarsResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly skippedExisting: number;
  readonly skippedReason: string | null;
}

export function yahooCollectionBlockReason(symbol: string, instrumentType: string): string | null {
  if (instrumentType !== "INDEX") return null;
  const upper = symbol.trim().toUpperCase();
  if (YAHOO_MAPPED_SYMBOLS.includes(upper)) return null;
  return "YAHOO_TICKER_UNVERIFIED";
}

function effectiveKey(record: Pick<CanonicalRawRecord, "effectiveAt">): string {
  return record.effectiveAt.toISOString();
}

export class IngestMarketBars {
  constructor(
    private readonly marketData: MarketDataAdapter,
    private readonly store: StockIntelligenceStore,
  ) {}

  async execute(input: {
    instrumentId: string;
    symbol: string;
    instrumentType: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<IngestMarketBarsResult> {
    const blocked = yahooCollectionBlockReason(input.symbol, input.instrumentType);
    if (blocked) {
      return { fetched: 0, inserted: 0, skippedExisting: 0, skippedReason: blocked };
    }

    const existing = await this.store.listRawAsOf(input.instrumentId, input.dataCutoff, YAHOO_DAILY_BAR_SOURCE_KIND);
    const seen = new Set(existing.map(effectiveKey));

    const bars = await this.marketData.fetchDailyBars({
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      from: input.from,
      to: input.to,
      dataCutoff: input.dataCutoff,
    });

    let inserted = 0;
    let skippedExisting = 0;
    for (const bar of bars) {
      const record = {
        instrumentId: bar.instrumentId,
        sourceKind: YAHOO_DAILY_BAR_SOURCE_KIND,
        payload: rawPayloadFromMarketBar(bar),
        publishedAt: bar.publishedAt,
        effectiveAt: bar.effectiveAt,
        availableAt: bar.availableAt,
        dataSchemaVersion: STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION,
      };
      if (seen.has(effectiveKey(record))) {
        skippedExisting += 1;
        continue;
      }
      await this.store.insertRaw(record);
      seen.add(effectiveKey(record));
      inserted += 1;
    }

    return { fetched: bars.length, inserted, skippedExisting, skippedReason: null };
  }
}

export async function loadStoredMarketBars(
  store: StockIntelligenceStore,
  instrumentId: string,
  dataCutoff: Date,
) {
  const rows = await store.listRawAsOf(instrumentId, dataCutoff, YAHOO_DAILY_BAR_SOURCE_KIND);
  return rows
    .map((row) => marketBarFromRaw(row))
    .filter((bar): bar is NonNullable<typeof bar> => bar !== null);
}
