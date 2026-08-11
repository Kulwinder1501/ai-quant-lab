import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import type { CandleRepository, PersistedCandle, UpsertCandleInput } from "../../../modules/market-data/domain/candle.js";

interface CandleRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  timeframe: string;
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  is_complete: boolean;
  source: string;
  ingestion_id: string | null;
  source_metadata: Record<string, unknown>;
}

const returningColumns = `
  id, instrument_id, timeframe, open_time, close_time, open, high, low,
  close, volume, is_complete, source, ingestion_id, source_metadata
`;

function toCandle(row: CandleRow): PersistedCandle {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    timeframe: row.timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    isComplete: row.is_complete,
    source: row.source,
    ingestionId: row.ingestion_id,
    sourceMetadata: row.source_metadata,
  };
}

function normalizeDecimal(value: string): string {
  const [wholePart, decimalPart = ""] = value.trim().split(".");
  const whole = wholePart.replace(/^(-?)0+(?=\d)/, "$1") || "0";
  const decimal = decimalPart.replace(/0+$/, "");
  return decimal ? `${whole}.${decimal}` : whole;
}

function hasSameValues(candle: PersistedCandle, input: UpsertCandleInput): boolean {
  return candle.closeTime.getTime() === input.closeTime.getTime()
    && normalizeDecimal(candle.open) === normalizeDecimal(input.open)
    && normalizeDecimal(candle.high) === normalizeDecimal(input.high)
    && normalizeDecimal(candle.low) === normalizeDecimal(input.low)
    && normalizeDecimal(candle.close) === normalizeDecimal(input.close)
    && normalizeDecimal(candle.volume) === normalizeDecimal(input.volume)
    && candle.source === input.source;
}

export class PostgresCandleRepository implements CandleRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: UpsertCandleInput): Promise<PersistedCandle> {
    const result = await this.database.query<CandleRow>(`
      INSERT INTO candles (
        instrument_id, ingestion_id, timeframe, open_time, close_time,
        open, high, low, close, volume, is_complete, source, source_metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
      )
      ON CONFLICT (instrument_id, timeframe, open_time) DO UPDATE SET
        ingestion_id = EXCLUDED.ingestion_id,
        close_time = EXCLUDED.close_time,
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        is_complete = EXCLUDED.is_complete,
        source = EXCLUDED.source,
        source_metadata = EXCLUDED.source_metadata,
        received_at = CURRENT_TIMESTAMP
      WHERE candles.is_complete = FALSE OR (candles.source_metadata ? 'quoteObservedAt')
      RETURNING ${returningColumns}
    `, [
      input.instrumentId,
      input.ingestionId ?? null,
      input.timeframe,
      input.openTime,
      input.closeTime,
      input.open,
      input.high,
      input.low,
      input.close,
      input.volume,
      input.isComplete,
      input.source,
      JSON.stringify(input.sourceMetadata ?? {}),
    ]);

    if (result.rows[0]) {
      return toCandle(result.rows[0]);
    }

    const existing = await this.findByKey(input.instrumentId, input.timeframe, input.openTime);
    if (!existing) {
      throw new Error("Candle upsert did not return a row.");
    }
    if (!hasSameValues(existing, input)) {
      throw new Error("Completed candles are immutable; record a provider correction as a new data revision.");
    }
    return existing;
  }

  async findByKey(instrumentId: string, timeframe: string, openTime: Date): Promise<PersistedCandle | null> {
    const result = await this.database.query<CandleRow>(`
      SELECT ${returningColumns}
      FROM candles
      WHERE instrument_id = $1 AND timeframe = $2 AND open_time = $3
    `, [instrumentId, timeframe, openTime]);
    return result.rows[0] ? toCandle(result.rows[0]) : null;
  }

  async listIncomplete(instrumentIds: string[], timeframe: string, closedBefore: Date): Promise<PersistedCandle[]> {
    if (instrumentIds.length === 0) {
      return [];
    }
    const result = await this.database.query<CandleRow>(`
      SELECT ${returningColumns}
      FROM candles
      WHERE instrument_id = ANY($1::uuid[])
        AND timeframe = $2
        AND is_complete = FALSE
        AND close_time <= $3
      ORDER BY open_time ASC
    `, [instrumentIds, timeframe, closedBefore]);
    return result.rows.map(toCandle);
  }

  async listCompleted(instrumentId: string, timeframe: string): Promise<PersistedCandle[]> {
    const result = await this.database.query<CandleRow>(`
      SELECT ${returningColumns}
      FROM candles
      WHERE instrument_id = $1 AND timeframe = $2 AND is_complete = TRUE
      ORDER BY open_time ASC
    `, [instrumentId, timeframe]);
    return result.rows.map(toCandle);
  }

  /**
   * The settled daily close for a symbol on a session, by symbol rather than id.
   *
   * Restricted to complete candles: a provisional close is still moving, and this
   * is used as the denominator of an offshore premium, where a mid-session value
   * would silently misreport the gap. Returns null when the session has no settled
   * daily bar, which a caller reports as an unmeasurable gap rather than zero.
   */
  async findCloseOn(symbol: string, date: Date): Promise<number | null> {
    const result = await this.database.query<{ close: string }>(`
      SELECT c.close
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1
        AND c.timeframe = '1d'
        AND c.is_complete = TRUE
        AND c.open_time >= $2::date
        AND c.open_time < ($2::date + INTERVAL '1 day')
      ORDER BY c.open_time DESC
      LIMIT 1
    `, [symbol, date.toISOString().slice(0, 10)]);

    const row = result.rows[0];
    if (!row) return null;
    const parsed = Number.parseFloat(String(row.close));
    return Number.isFinite(parsed) ? parsed : null;
  }
}
