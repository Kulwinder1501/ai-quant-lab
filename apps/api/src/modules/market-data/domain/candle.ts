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

export interface CandleRepository {
  upsert(input: UpsertCandleInput): Promise<PersistedCandle>;
  findByKey(instrumentId: string, timeframe: string, openTime: Date): Promise<PersistedCandle | null>;
  listIncomplete(instrumentIds: string[], timeframe: string, closedBefore: Date): Promise<PersistedCandle[]>;
  listCompleted(instrumentId: string, timeframe: string): Promise<PersistedCandle[]>;
}
