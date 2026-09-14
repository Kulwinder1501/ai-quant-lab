import type {
  DailyConfusionRow,
  DailyScoreUpsert,
  ModelPredictionSettlementRepository,
  SettleableModel,
} from "../../../modules/model-predictions/application/settle-model-predictions.js";
import type { DirectionalLabel } from "../../../modules/model-predictions/domain/model-competition.js";
import { DIRECTIONAL_LABEL_SCHEMES } from "../../../modules/model-predictions/domain/competition-eligibility.js";
import { directionalLabelFromForwardReturnBps } from "../../../modules/model-predictions/domain/directional-label.js";
import type { DatabasePool } from "../database.js";

/**
 * Settles predictions with the same label mathematics the trainer and the
 * predict-time reliability query use: the realized label is the sign of the
 * close-to-close return `horizon_bars` completed bars ahead, against the
 * model's own symmetric neutral band. Intraday LEADs are partitioned by IST
 * session so a label can never straddle the overnight gap and measure the gap
 * instead of the move; predictions whose horizon crosses the session boundary
 * therefore never mature and stay unsettled by design.
 */
const SETTLE_SQL = `
  WITH targets AS (
    SELECT DISTINCT c.instrument_id, c.timeframe
    FROM model_predictions p
    INNER JOIN candles c ON c.id = p.source_candle_id
    WHERE p.model_version_id = $1 AND p.settled_at IS NULL
  ),
  cutoff_candles AS (
    SELECT
      candles.id,
      candles.close,
      candles.close_time,
      LEAD(candles.close, $2::int) OVER w AS future_close,
      LEAD(candles.close_time, $2::int) OVER w AS future_close_time
    FROM candles
    INNER JOIN targets
      ON targets.instrument_id = candles.instrument_id
      AND targets.timeframe = candles.timeframe
    WHERE candles.is_complete = TRUE
    WINDOW w AS (
      PARTITION BY
        candles.instrument_id,
        candles.timeframe,
        CASE
          WHEN candles.timeframe ~* '[mh]$' THEN (candles.close_time AT TIME ZONE 'Asia/Kolkata')::date
          ELSE DATE '1970-01-01'
        END
      ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
    )
  )
  UPDATE model_predictions p
  SET
    settled_at = CURRENT_TIMESTAMP,
    realized_return_bps = ROUND((((cc.future_close - cc.close) / cc.close) * 10000)::numeric, 4),
    realized_label = CASE
      WHEN ((cc.future_close - cc.close) / cc.close) * 10000 > $3 THEN 'BULLISH'
      WHEN ((cc.future_close - cc.close) / cc.close) * 10000 < -$3 THEN 'BEARISH'
      ELSE 'NEUTRAL'
    END,
    was_correct = p.prediction = CASE
      WHEN ((cc.future_close - cc.close) / cc.close) * 10000 > $3 THEN 'BULLISH'
      WHEN ((cc.future_close - cc.close) / cc.close) * 10000 < -$3 THEN 'BEARISH'
      ELSE 'NEUTRAL'
    END
  FROM cutoff_candles cc
  WHERE cc.id = p.source_candle_id
    AND p.model_version_id = $1
    AND p.settled_at IS NULL
    AND cc.future_close IS NOT NULL
  RETURNING
    (cc.close_time AT TIME ZONE 'Asia/Kolkata')::date::text AS score_date,
    p.realized_return_bps,
    p.realized_label
`;

function toFiniteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresModelPredictionSettlementRepository implements ModelPredictionSettlementRepository {
  constructor(private readonly database: DatabasePool) {}

  async listModelsWithUnsettledPredictions(): Promise<SettleableModel[]> {
    const result = await this.database.query(`
      SELECT
        mv.id AS model_version_id,
        mv.model_key,
        mv.validation_metrics -> 'validationProtocol' ->> 'horizonBars' AS horizon_bars,
        mv.validation_metrics -> 'validationProtocol' ->> 'neutralThresholdBps' AS neutral_threshold_bps,
        COUNT(*)::int AS unsettled_count
      FROM model_predictions mp
      INNER JOIN model_versions mv ON mv.id = mp.model_version_id
      WHERE mp.settled_at IS NULL
        -- Only models whose target actually is a trade direction. model_predictions
        -- already CHECKs its prediction column against the directional alphabet, so a
        -- non-directional model cannot have rows here -- but grading depends on reading
        -- neutralThresholdBps from the model's protocol, and a volatility model carries a
        -- value there (50.0) that means nothing for its real target. Naming the schemes
        -- makes the requirement explicit instead of relying on a constraint two tables away.
        AND (mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme') = ANY($1)
      GROUP BY mv.id, mv.model_key, horizon_bars, neutral_threshold_bps
      ORDER BY mv.model_key, mv.id
    `, [DIRECTIONAL_LABEL_SCHEMES]);
    return result.rows.map((row) => {
      const record = row as {
        model_version_id: string;
        model_key: string;
        horizon_bars: string | null;
        neutral_threshold_bps: string | null;
        unsettled_count: number;
      };
      return {
        modelVersionId: record.model_version_id,
        modelKey: record.model_key,
        horizonBars: toFiniteOrNull(record.horizon_bars),
        neutralThresholdBps: toFiniteOrNull(record.neutral_threshold_bps),
        unsettledCount: record.unsettled_count,
      };
    });
  }

  async settlePredictionsForModel(input: {
    modelVersionId: string;
    horizonBars: number;
    neutralThresholdBps: number;
  }): Promise<string[]> {
    const result = await this.database.query(SETTLE_SQL, [
      input.modelVersionId,
      input.horizonBars,
      input.neutralThresholdBps,
    ]);

    // The SQL and the trainer are two implementations of one labelling rule, so every
    // label it just wrote is re-derived here from the return the SQL itself computed. A
    // disagreement means the band semantics have drifted apart, which would otherwise
    // corrupt every live accuracy figure while looking entirely reasonable. Loud beats
    // silent: the run fails and nothing downstream scores on mixed definitions.
    const scoreDates: string[] = [];
    for (const row of result.rows) {
      const record = row as { score_date: string; realized_return_bps: string; realized_label: DirectionalLabel };
      const returnBps = Number(record.realized_return_bps);
      const expected = directionalLabelFromForwardReturnBps(returnBps, input.neutralThresholdBps);
      if (expected !== record.realized_label) {
        throw new Error(
          `Settlement labelling disagreed with the shared rule for model ${input.modelVersionId}: `
          + `a ${returnBps}bps return at a ${input.neutralThresholdBps}bps band was stored as `
          + `${record.realized_label} but the rule gives ${expected}. The settlement SQL and `
          + "directionalLabelFromForwardReturnBps have drifted; reconcile them before scoring.",
        );
      }
      scoreDates.push(record.score_date);
    }
    return scoreDates;
  }

  async settledConfusionByDate(modelVersionId: string, scoreDates: string[]): Promise<DailyConfusionRow[]> {
    if (scoreDates.length === 0) return [];
    const result = await this.database.query(`
      SELECT
        (c.close_time AT TIME ZONE 'Asia/Kolkata')::date::text AS score_date,
        p.prediction,
        p.realized_label,
        COUNT(*)::int AS count
      FROM model_predictions p
      INNER JOIN candles c ON c.id = p.source_candle_id
      WHERE p.model_version_id = $1
        AND p.settled_at IS NOT NULL
        AND (c.close_time AT TIME ZONE 'Asia/Kolkata')::date = ANY($2::date[])
      GROUP BY score_date, p.prediction, p.realized_label
    `, [modelVersionId, scoreDates]);
    return result.rows.map((row) => {
      const record = row as {
        score_date: string;
        prediction: DirectionalLabel;
        realized_label: DirectionalLabel;
        count: number;
      };
      return {
        scoreDate: record.score_date,
        cell: { prediction: record.prediction, realizedLabel: record.realized_label, count: record.count },
      };
    });
  }

  async upsertDailyScore(input: DailyScoreUpsert): Promise<void> {
    await this.database.query(`
      INSERT INTO model_daily_scores (
        model_version_id, score_date, predictions_settled, predictions_correct,
        accuracy, macro_f1, directional_hit_rate, baseline_accuracy
      ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (model_version_id, score_date) DO UPDATE SET
        predictions_settled = EXCLUDED.predictions_settled,
        predictions_correct = EXCLUDED.predictions_correct,
        accuracy = EXCLUDED.accuracy,
        macro_f1 = EXCLUDED.macro_f1,
        directional_hit_rate = EXCLUDED.directional_hit_rate,
        baseline_accuracy = EXCLUDED.baseline_accuracy
    `, [
      input.modelVersionId,
      input.scoreDate,
      input.predictionsSettled,
      input.predictionsCorrect,
      input.accuracy,
      input.macroF1,
      input.directionalHitRate,
      input.baselineAccuracy,
    ]);
  }
}
