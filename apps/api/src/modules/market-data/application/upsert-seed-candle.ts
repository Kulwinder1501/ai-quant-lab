import type { DatabaseClient } from "../../../infrastructure/database/database.js";
import { SEED_SOURCE_METADATA, YAHOO_PROVIDER_ID } from "../domain/candle-provenance.js";

export interface SeedCandleInput {
  instrumentId: string;
  timeframe: string;
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Inserts a seed candle, leaving an already-completed one alone, and returns its id.
 *
 * Both seeds previously ran their own raw upsert with an unguarded
 * `ON CONFLICT ... DO UPDATE`, while `PostgresCandleRepository.upsert` -- the path all
 * real ingestion goes through -- restricts the same update with
 * `WHERE candles.is_complete = FALSE`. A completed candle is settled history, and the
 * seeds could silently rewrite it: the backtests and the ML feature builders read those
 * exact rows, so a seed run could move results underneath them. That the prices happened
 * to match on the last run was luck (both fetch from Yahoo), not protection.
 *
 * The guard makes the conflicting update produce no row, so the id is read back
 * separately rather than assumed from `RETURNING`, which is what the previous inline
 * version relied on. It also unifies the two seeds' update lists, which disagreed --
 * the market seed refreshed `open` and the scalp seed did not.
 */
export async function upsertSeedCandle(client: DatabaseClient, input: SeedCandleInput): Promise<string> {
  const result = await client.query<{ id: string }>(`
    INSERT INTO candles (
      instrument_id, timeframe, open_time, close_time,
      open, high, low, close, volume, is_complete, source, source_metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11::jsonb)
    ON CONFLICT (instrument_id, timeframe, open_time) DO UPDATE
    SET close_time = EXCLUDED.close_time,
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume
    WHERE candles.is_complete = FALSE
    RETURNING id
  `, [
    input.instrumentId,
    input.timeframe,
    input.openTime,
    input.closeTime,
    input.open,
    input.high,
    input.low,
    input.close,
    input.volume,
    YAHOO_PROVIDER_ID,
    SEED_SOURCE_METADATA,
  ]);

  const inserted = result.rows[0]?.id;
  if (inserted) return inserted;

  // The row exists and is complete, so the guard skipped it. Its id is still needed
  // by everything the seed attaches to the candle.
  const existing = await client.query<{ id: string }>(`
    SELECT id FROM candles
    WHERE instrument_id = $1 AND timeframe = $2 AND open_time = $3
  `, [input.instrumentId, input.timeframe, input.openTime]);

  const id = existing.rows[0]?.id;
  if (!id) {
    throw new Error(
      `Seed candle for instrument ${input.instrumentId} ${input.timeframe} at ${input.openTime.toISOString()} `
      + "was neither written nor found.",
    );
  }
  return id;
}
