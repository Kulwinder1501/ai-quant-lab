/**
 * Decimal values remain strings at the persistence boundary so JavaScript never
 * silently rounds market prices or volumes. Convert only at a deliberate math boundary.
 */
export interface PersistedCandle {
  id: string;
  instrumentId: string;
  timeframe: string;
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isComplete: boolean;
  source: string;
  ingestionId: string | null;
  sourceMetadata: Record<string, unknown>;
}

export interface UpsertCandleInput {
  instrumentId: string;
  ingestionId?: string | null;
  timeframe: string;
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isComplete: boolean;
  source: string;
  sourceMetadata?: Record<string, unknown>;
}

/**
 * An `upsert` that a settled candle refused.
 *
 * Named rather than generic because the two writers of a bar want opposite things from the
 * refusal. `ImportHistoricalMarketData` is asserting the settled series, so a refusal there
 * means the provider changed a bar it had already reported and must stay loud. The live
 * collector races that importer *by design* -- INDICES_INTRADAY re-fetches the same index bars
 * every minute -- so for it a refusal only means the authoritative writer arrived first, and
 * the correct response is to yield rather than to die.
 *
 * The message is unchanged from when this was a bare `Error`, since it is what any existing
 * log search matches on.
 */
export class CompletedCandleImmutableError extends Error {
  constructor(readonly candleKey: { instrumentId: string; timeframe: string; openTime: Date }) {
    super("Completed candles are immutable; record a provider correction as a new data revision.");
    this.name = "CompletedCandleImmutableError";
  }
}

export interface CandleRepository {
  /** Throws {@link CompletedCandleImmutableError} if a settled bar refuses the overwrite. */
  upsert(input: UpsertCandleInput): Promise<PersistedCandle>;
  findByKey(instrumentId: string, timeframe: string, openTime: Date): Promise<PersistedCandle | null>;
  listIncomplete(instrumentIds: string[], timeframe: string, closedBefore: Date): Promise<PersistedCandle[]>;
  listCompleted(instrumentId: string, timeframe: string): Promise<PersistedCandle[]>;
}
