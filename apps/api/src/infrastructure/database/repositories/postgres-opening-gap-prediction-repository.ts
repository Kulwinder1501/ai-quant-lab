import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import type {
  OpeningGapClassifierInstrument,
  GapExpectation,
} from "../../../modules/market-data/domain/opening-gap-classifier.js";
import type { OpeningGapPrediction, OpeningGapPredictionDraft } from "../../../modules/market-data/domain/opening-gap-prediction.js";
import type { SettleableOpeningGapPrediction } from "../../../modules/market-data/application/settle-opening-gap-predictions.js";

interface PredictionRow extends QueryResultRow {
  id: string;
  instrument_symbol: string;
  session_date: Date;
  predicted_at: Date;
  driver_symbol: string;
  driver_change_pct: string;
  threshold_pct: string;
  expectation: string;
  supplementary_cues: Record<string, number | null>;
}

function toSessionDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toPrediction(row: PredictionRow): OpeningGapPrediction {
  return {
    id: row.id,
    instrumentSymbol: row.instrument_symbol as OpeningGapClassifierInstrument,
    sessionDate: toSessionDateKey(row.session_date),
    predictedAt: row.predicted_at,
    driverSymbol: row.driver_symbol,
    driverChangePct: Number.parseFloat(row.driver_change_pct),
    thresholdPct: Number.parseFloat(row.threshold_pct),
    expectation: row.expectation as GapExpectation,
    supplementaryCues: row.supplementary_cues,
  };
}

/**
 * Persistence for `opening_gap_predictions`.
 *
 * Also owns the two small settlement-time reads (`findPreviousClose`, `findSessionOpen`):
 * narrow, single-purpose ports in the same spirit as `DomesticCloseReader` in
 * `get-institutional-context.ts`, not a general candle-query surface.
 */
export class PostgresOpeningGapPredictionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Insert, or overwrite the pre-settlement fields of a same-day re-run. Never touches an
   * already-settled row -- the `WHERE` clause on the conflict branch makes that structurally
   * impossible rather than relying on the caller not to re-run after 09:15.
   */
  async upsert(prediction: OpeningGapPredictionDraft): Promise<OpeningGapPrediction> {
    const result = await this.database.query<PredictionRow>(
      `
      INSERT INTO opening_gap_predictions (
        instrument_symbol, session_date, driver_symbol, driver_change_pct,
        threshold_pct, expectation, supplementary_cues
      ) VALUES ($1, $2::date, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (instrument_symbol, session_date) DO UPDATE SET
        driver_symbol = EXCLUDED.driver_symbol,
        driver_change_pct = EXCLUDED.driver_change_pct,
        threshold_pct = EXCLUDED.threshold_pct,
        expectation = EXCLUDED.expectation,
        supplementary_cues = EXCLUDED.supplementary_cues,
        predicted_at = NOW(),
        updated_at = NOW()
      WHERE opening_gap_predictions.settled_at IS NULL
      RETURNING id, instrument_symbol, session_date, predicted_at, driver_symbol,
        driver_change_pct, threshold_pct, expectation, supplementary_cues
      `,
      [
        prediction.instrumentSymbol,
        prediction.sessionDate,
        prediction.driverSymbol,
        prediction.driverChangePct,
        prediction.thresholdPct,
        prediction.expectation,
        JSON.stringify(prediction.supplementaryCues),
      ],
    );

    if (result.rows[0]) {
      return toPrediction(result.rows[0]);
    }

    // The conflict's WHERE excluded the row (it is already settled). Return the existing
    // settled row rather than erroring -- a stray re-run of the morning predictor after
    // settlement has already happened should be a no-op, not a failure.
    const existing = await this.database.query<PredictionRow>(
      `
      SELECT id, instrument_symbol, session_date, predicted_at, driver_symbol,
        driver_change_pct, threshold_pct, expectation, supplementary_cues
      FROM opening_gap_predictions
      WHERE instrument_symbol = $1 AND session_date = $2::date
      `,
      [prediction.instrumentSymbol, prediction.sessionDate],
    );
    if (!existing.rows[0]) {
      throw new Error("Opening gap prediction upsert did not return a row and none exists.");
    }
    return toPrediction(existing.rows[0]);
  }

  async listPendingSettlement(limit: number): Promise<SettleableOpeningGapPrediction[]> {
    const result = await this.database.query<{
      id: string;
      instrument_symbol: string;
      session_date: Date;
      expectation: string;
    }>(
      `
      SELECT id, instrument_symbol, session_date, expectation
      FROM opening_gap_predictions
      WHERE settled_at IS NULL AND unsettleable_reason IS NULL
      ORDER BY session_date ASC
      LIMIT $1
      `,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      instrumentSymbol: row.instrument_symbol as OpeningGapClassifierInstrument,
      sessionDate: toSessionDateKey(row.session_date),
      expectation: row.expectation as GapExpectation,
    }));
  }

  /** The most recently settled daily close strictly before `sessionDate`. */
  async findPreviousClose(symbol: string, sessionDate: string): Promise<number | null> {
    const result = await this.database.query<{ close: string }>(
      `
      SELECT c.close
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1
        AND c.timeframe = '1d'
        AND c.is_complete = TRUE
        AND c.open_time < $2::date
      ORDER BY c.open_time DESC
      LIMIT 1
      `,
      [symbol, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return null;
    const parsed = Number.parseFloat(row.close);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** The open of the 1-minute candle at a specific UTC instant (09:15 IST on `sessionDate`). */
  async findSessionOpen(symbol: string, sessionOpenInstant: Date): Promise<number | null> {
    const result = await this.database.query<{ open: string }>(
      `
      SELECT c.open
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1
        AND c.timeframe = '1m'
        AND c.open_time = $2
        AND c.is_complete = TRUE
      `,
      [symbol, sessionOpenInstant],
    );
    const row = result.rows[0];
    if (!row) return null;
    const parsed = Number.parseFloat(row.open);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async recordSettlement(
    id: string,
    outcome: {
      previousClose: number;
      actualOpen: number;
      actualGapPct: number;
      actualExpectation: GapExpectation;
      wasCorrect: boolean;
    },
  ): Promise<void> {
    await this.database.query(
      `
      UPDATE opening_gap_predictions
      SET previous_close = $2,
          actual_open = $3,
          actual_gap_pct = $4,
          actual_expectation = $5,
          was_correct = $6,
          settled_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND settled_at IS NULL
      `,
      [
        id,
        outcome.previousClose,
        outcome.actualOpen,
        outcome.actualGapPct,
        outcome.actualExpectation,
        outcome.wasCorrect,
      ],
    );
  }

  async recordUnsettleable(id: string, reason: string): Promise<void> {
    await this.database.query(
      `
      UPDATE opening_gap_predictions
      SET unsettleable_reason = $2, updated_at = NOW()
      WHERE id = $1 AND settled_at IS NULL
      `,
      [id, reason],
    );
  }
}
