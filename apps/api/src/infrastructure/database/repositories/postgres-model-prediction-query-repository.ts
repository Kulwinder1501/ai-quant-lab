import type { QueryResultRow } from "pg";
import type {
  JsonObject,
  JsonValue,
  ListModelPredictionsInput,
  ModelPredictionDetail,
  ModelPredictionLabel,
  ModelPredictionQueryRepository,
  ModelPredictionSummary,
  ModelStage,
  PredictionModelDetail,
  PredictionModelSummary,
  PredictionSourceCandle,
} from "../../../modules/model-predictions/domain/model-prediction.js";
import type { DatabaseQueryable } from "../database.js";

interface ModelPredictionRow extends QueryResultRow {
  prediction_id: string;
  prediction: ModelPredictionLabel;
  confidence: string | number;
  prediction_created_at: Date | string;
  evidence_cutoff_at: Date | string;
  instrument_id: string;
  instrument_exchange: string;
  instrument_symbol: string;
  instrument_display_name: string;
  source_candle_id: string | null;
  source_timeframe: string | null;
  source_open_time: Date | string | null;
  source_close_time: Date | string | null;
  source_open: string | number | null;
  source_high: string | number | null;
  source_low: string | number | null;
  source_close: string | number | null;
  source_volume: string | number | null;
  model_version_id: string;
  model_key: string;
  model_version: number | string;
  model_algorithm: string;
  model_current_stage: ModelStage;
  model_artifact_checksum: string | null;
  model_training_rows: number | string;
  model_validation_metrics: unknown;
  model_trained_at: Date | string;
  model_promoted_at: Date | string | null;
  model_feature_schema?: unknown;
  model_training_window_start?: Date | string;
  model_training_window_end?: Date | string;
  feature_contributions?: unknown;
  explanation?: unknown;
}

const commonColumns = `
  mp.id AS prediction_id,
  mp.prediction,
  mp.confidence,
  mp.created_at AS prediction_created_at,
  mp.evidence_cutoff_at,
  i.id AS instrument_id,
  i.exchange AS instrument_exchange,
  i.symbol AS instrument_symbol,
  i.display_name AS instrument_display_name,
  c.id AS source_candle_id,
  c.timeframe AS source_timeframe,
  c.open_time AS source_open_time,
  c.close_time AS source_close_time,
  c.open AS source_open,
  c.high AS source_high,
  c.low AS source_low,
  c.close AS source_close,
  c.volume AS source_volume,
  mv.id AS model_version_id,
  mv.model_key,
  mv.version AS model_version,
  mv.algorithm AS model_algorithm,
  mv.stage AS model_current_stage,
  mv.artifact_checksum AS model_artifact_checksum,
  mv.training_rows AS model_training_rows,
  mv.validation_metrics AS model_validation_metrics,
  mv.trained_at AS model_trained_at,
  mv.promoted_at AS model_promoted_at
`;

const joins = `
  FROM model_predictions mp
  INNER JOIN instruments i ON i.id = mp.instrument_id
  INNER JOIN model_versions mv ON mv.id = mp.model_version_id
  LEFT JOIN candles c ON c.id = mp.source_candle_id
`;

function asFiniteNumber(value: string | number, field: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return numberValue;
}

function asPositiveInteger(value: string | number, field: string): number {
  const numberValue = asFiniteNumber(value, field);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return numberValue;
}

function asDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asJsonObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value as JsonObject;
}

function asJsonArray(value: unknown, field: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value as JsonValue[];
}

function asModelStage(value: ModelStage): ModelStage {
  if (!["CANDIDATE", "PRODUCTION", "REJECTED", "ARCHIVED"].includes(value)) {
    throw new Error("Database returned an invalid model stage.");
  }
  return value;
}

function asInstrumentExchange(value: string): "NSE" | "NFO" | "BSE" {
  if (value !== "NSE" && value !== "NFO" && value !== "BSE") {
    throw new Error("Database returned an invalid instrument exchange.");
  }
  return value;
}

function toSourceCandle(row: ModelPredictionRow): PredictionSourceCandle | null {
  if (row.source_candle_id === null) {
    return null;
  }
  if (
    row.source_timeframe === null
    || row.source_open_time === null
    || row.source_close_time === null
    || row.source_open === null
    || row.source_high === null
    || row.source_low === null
    || row.source_close === null
    || row.source_volume === null
  ) {
    throw new Error("Database returned incomplete source candle evidence.");
  }
  return {
    id: row.source_candle_id,
    timeframe: row.source_timeframe,
    openTime: asDate(row.source_open_time, "source candle open time"),
    closeTime: asDate(row.source_close_time, "source candle close time"),
    open: asFiniteNumber(row.source_open, "source candle open"),
    high: asFiniteNumber(row.source_high, "source candle high"),
    low: asFiniteNumber(row.source_low, "source candle low"),
    close: asFiniteNumber(row.source_close, "source candle close"),
    volume: asFiniteNumber(row.source_volume, "source candle volume"),
  };
}

function toModelSummary(row: ModelPredictionRow): PredictionModelSummary {
  return {
    id: row.model_version_id,
    key: row.model_key,
    version: asPositiveInteger(row.model_version, "model version"),
    algorithm: row.model_algorithm,
    currentStage: asModelStage(row.model_current_stage),
    artifactChecksum: row.model_artifact_checksum,
    trainingRows: asPositiveInteger(row.model_training_rows, "model training rows"),
    validationMetrics: asJsonObject(row.model_validation_metrics, "model validation metrics"),
    trainedAt: asDate(row.model_trained_at, "model trained at"),
    promotedAt: row.model_promoted_at === null ? null : asDate(row.model_promoted_at, "model promoted at"),
  };
}

function toSummary(row: ModelPredictionRow): ModelPredictionSummary {
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(row.prediction)) {
    throw new Error("Database returned an invalid prediction label.");
  }
  const confidence = asFiniteNumber(row.confidence, "prediction confidence");
  if (confidence < 0 || confidence > 1) {
    throw new Error("Database returned an invalid prediction confidence.");
  }
  return {
    researchOnly: true,
    id: row.prediction_id,
    prediction: row.prediction,
    confidence,
    createdAt: asDate(row.prediction_created_at, "prediction created at"),
    evidenceCutoffAt: asDate(row.evidence_cutoff_at, "prediction evidence cutoff"),
    instrument: {
      id: row.instrument_id,
      exchange: asInstrumentExchange(row.instrument_exchange),
      symbol: row.instrument_symbol,
      displayName: row.instrument_display_name,
    },
    sourceCandle: toSourceCandle(row),
    model: toModelSummary(row),
  };
}

function toDetail(row: ModelPredictionRow): ModelPredictionDetail {
  if (row.model_feature_schema === undefined || row.model_training_window_start === undefined || row.model_training_window_end === undefined) {
    throw new Error("Database did not return model detail evidence.");
  }
  if (row.feature_contributions === undefined || row.explanation === undefined) {
    throw new Error("Database did not return prediction explanation evidence.");
  }
  const summary = toSummary(row);
  const model: PredictionModelDetail = {
    ...summary.model,
    featureSchema: asJsonArray(row.model_feature_schema, "model feature schema"),
    trainingWindow: {
      start: asDate(row.model_training_window_start, "model training window start"),
      end: asDate(row.model_training_window_end, "model training window end"),
    },
  };
  return {
    ...summary,
    model,
    featureContributions: asJsonArray(row.feature_contributions, "feature contributions"),
    explanation: asJsonArray(row.explanation, "prediction explanation"),
  };
}

/** Read-only projection for Phase 11 local-model research records. It contains no write SQL. */
export class PostgresModelPredictionQueryRepository implements ModelPredictionQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async list(input: ListModelPredictionsInput): Promise<ModelPredictionSummary[]> {
    const result = await this.database.query<ModelPredictionRow>(`
      SELECT ${commonColumns}
      ${joins}
      WHERE ($1::text IS NULL OR i.symbol = $1)
        AND ($2::text IS NULL OR mv.model_key = $2)
        AND ($3::text IS NULL OR c.timeframe = $3)
        AND ($4::text IS NULL OR mp.prediction = $4)
        AND (
          $5::timestamptz IS NULL
          OR date_trunc('milliseconds', mp.created_at) < $5
          OR (date_trunc('milliseconds', mp.created_at) = $5 AND mp.id < $6::uuid)
        )
      -- The cursor is an ISO millisecond timestamp, so this same normalized
      -- expression must also be the leading deterministic ordering key.
      ORDER BY date_trunc('milliseconds', mp.created_at) DESC, mp.id DESC
      LIMIT $7::integer
    `, [
      input.instrumentSymbol ?? null,
      input.modelKey ?? null,
      input.timeframe ?? null,
      input.prediction ?? null,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      input.limit,
    ]);
    return result.rows.map(toSummary);
  }

  async findById(predictionId: string): Promise<ModelPredictionDetail | null> {
    const result = await this.database.query<ModelPredictionRow>(`
      SELECT
        ${commonColumns},
        mv.feature_schema AS model_feature_schema,
        mv.training_window_start AS model_training_window_start,
        mv.training_window_end AS model_training_window_end,
        mp.feature_contributions,
        mp.explanation
      ${joins}
      WHERE mp.id = $1::uuid
    `, [predictionId]);
    return result.rows[0] ? toDetail(result.rows[0]) : null;
  }
}
