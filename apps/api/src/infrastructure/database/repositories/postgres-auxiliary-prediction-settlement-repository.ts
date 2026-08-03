import type { DatabaseQueryable } from "../database.js";
import type {
  AuxiliaryPredictionSettlementRepository,
  AuxiliarySettlementOutcome,
  SettleableAuxiliaryPrediction,
} from "../../../modules/model-predictions/application/settle-auxiliary-predictions.js";
import type { RangeBar } from "../../../modules/model-predictions/domain/volatility-expansion-label.js";

const VOLATILITY_SCHEME = "volatility-expansion-v1";

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresAuxiliaryPredictionSettlementRepository
implements AuxiliaryPredictionSettlementRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Matured-but-ungraded volatility predictions, oldest first.
   *
   * `horizonBars` and `expansionBand` are read from each model's own persisted
   * `validationProtocol` rather than from a shared constant, so a live prediction is
   * always graded under the rule its model was trained on. A model whose protocol
   * lacks the band yields NULL here and the service skips it rather than guessing.
   */
  async listSettleableVolatilityPredictions(limit: number): Promise<SettleableAuxiliaryPrediction[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 50_000));
    const result = await this.database.query(`
      SELECT
        amp.id,
        amp.model_version_id,
        mv.model_key,
        amp.instrument_id,
        amp.prediction,
        c.timeframe,
        c.close_time,
        (mv.validation_metrics -> 'validationProtocol' ->> 'horizonBars')    AS horizon_bars,
        (mv.validation_metrics -> 'validationProtocol' ->> 'expansionBand')  AS expansion_band
      FROM auxiliary_model_predictions amp
      JOIN model_versions mv ON mv.id = amp.model_version_id
      JOIN candles c ON c.id = amp.source_candle_id
      WHERE amp.label_scheme = $1
        AND amp.settled_at IS NULL
        AND amp.unsettleable_reason IS NULL
        -- A prediction without a source candle has no window to grade against.
        AND amp.source_candle_id IS NOT NULL
      ORDER BY c.close_time ASC, amp.id ASC
      LIMIT $2
    `, [VOLATILITY_SCHEME, bounded]);

    return result.rows.map((row) => ({
      predictionId: String(row.id),
      modelVersionId: String(row.model_version_id),
      modelKey: String(row.model_key),
      instrumentId: String(row.instrument_id),
      timeframe: String(row.timeframe),
      prediction: String(row.prediction),
      sourceCandleCloseTime: row.close_time as Date,
      horizonBars: toNumberOrNull(row.horizon_bars),
      expansionBand: toNumberOrNull(row.expansion_band),
    }));
  }

  /**
   * The two equal-length windows the label rule compares.
   *
   * Only completed candles are read. A provisional bar's high and low are still
   * moving, so including one would grade a prediction against an envelope that has
   * not finished forming — and would bias it narrow, manufacturing CONTRACTION.
   */
  async loadRangeWindows(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
    horizonBars: number;
  }): Promise<{ trailing: RangeBar[]; forward: RangeBar[]; forwardCloseTime: Date | null }> {
    const [trailing, forward] = await Promise.all([
      this.database.query(`
        SELECT high, low FROM candles
        WHERE instrument_id = $1 AND timeframe = $2 AND is_complete = TRUE AND close_time <= $3
        ORDER BY close_time DESC
        LIMIT $4
      `, [input.instrumentId, input.timeframe, input.closeTime, input.horizonBars]),
      this.database.query(`
        SELECT high, low, close_time FROM candles
        WHERE instrument_id = $1 AND timeframe = $2 AND is_complete = TRUE AND close_time > $3
        ORDER BY close_time ASC
        LIMIT $4
      `, [input.instrumentId, input.timeframe, input.closeTime, input.horizonBars]),
    ]);

    const toBar = (row: Record<string, unknown>): RangeBar => ({
      high: Number(row.high),
      low: Number(row.low),
    });

    const forwardRows = forward.rows;
    return {
      // The trailing query returns newest-first; the rule reads the window in time order.
      trailing: trailing.rows.map(toBar).reverse(),
      forward: forwardRows.map(toBar),
      // The label becomes knowable at the close of the last bar in the forward window,
      // which is only defined once the window is complete.
      forwardCloseTime: forwardRows.length === input.horizonBars
        ? (forwardRows[forwardRows.length - 1].close_time as Date)
        : null,
    };
  }

  async recordSettlement(outcome: AuxiliarySettlementOutcome): Promise<void> {
    await this.database.query(`
      UPDATE auxiliary_model_predictions
      SET realized_label = $2,
          realized_ratio = $3,
          realized_forward_range = $4,
          realized_trailing_range = $5,
          label_available_at = $6,
          settled_at = NOW(),
          unsettleable_reason = NULL
      WHERE id = $1 AND settled_at IS NULL
    `, [
      outcome.predictionId,
      outcome.realizedLabel,
      outcome.rangeRatio,
      outcome.forwardRange,
      outcome.trailingRange,
      outcome.labelAvailableAt,
    ]);
  }

  async recordUnsettleable(predictionId: string, reason: string): Promise<void> {
    await this.database.query(`
      UPDATE auxiliary_model_predictions
      SET unsettleable_reason = $2
      WHERE id = $1 AND settled_at IS NULL
    `, [predictionId, reason]);
  }
}
