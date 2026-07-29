import type { QueryResultRow } from "pg";
import type { JsonObject, JsonValue, ModelStage } from "../../../modules/model-predictions/domain/model-prediction.js";
import { modelPredictionLabels, type ModelPredictionLabel } from "../../../modules/model-predictions/domain/model-prediction.js";
import {
  buildModelVersionPerformance,
  emptyPredictionActivity,
  type ListModelVersionsInput,
  type ModelPerformanceQueryRepository,
  type ModelPredictionActivity,
  type ModelVersionPerformance,
} from "../../../modules/model-performance/domain/model-performance.js";
import type { DatabaseQueryable } from "../database.js";

interface ModelVersionRow extends QueryResultRow {
  id: string;
  model_key: string;
  version: number | string;
  algorithm: string;
  stage: ModelStage;
  artifact_checksum: string | null;
  training_rows: number | string;
  training_window_start: Date | string;
  training_window_end: Date | string;
  validation_metrics: unknown;
  feature_schema: unknown;
  trained_at: Date | string;
  promoted_at: Date | string | null;
}

interface PredictionActivityRow extends QueryResultRow {
  model_version_id: string;
  prediction_count: number | string;
  average_confidence: number | string | null;
  first_prediction_at: Date | string | null;
  last_prediction_at: Date | string | null;
  prediction: ModelPredictionLabel;
  label_count: number | string;
}

function asFiniteNumber(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asModelStage(value: ModelStage): ModelStage {
  if (!["CANDIDATE", "PRODUCTION", "REJECTED", "ARCHIVED"].includes(value)) {
    throw new Error("Database returned an invalid model stage.");
  }
  return value;
}

/** A metrics envelope written by an older trainer may be anything; treat it as empty. */
function asMetricsEnvelope(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asFeatureSchema(value: unknown): JsonValue[] {
  return Array.isArray(value) ? value as JsonValue[] : [];
}

/**
 * Query-only access to the local model registry.
 *
 * It intentionally never selects `artifact_uri`: a dashboard has no reason to
 * learn a local file path, and the checksum is enough to identify an artifact.
 */
export class PostgresModelPerformanceQueryRepository implements ModelPerformanceQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async list(input: ListModelVersionsInput): Promise<ModelVersionPerformance[]> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];

    if (input.modelKey !== undefined) {
      parameters.push(input.modelKey);
      conditions.push(`mv.model_key = $${parameters.length}`);
    }
    if (input.algorithm !== undefined) {
      parameters.push(input.algorithm);
      conditions.push(`mv.algorithm = $${parameters.length}`);
    }
    if (input.stage !== undefined) {
      parameters.push(input.stage);
      conditions.push(`mv.stage = $${parameters.length}`);
    }
    parameters.push(input.limit);

    const versions = await this.database.query<ModelVersionRow>(`
      SELECT
        mv.id,
        mv.model_key,
        mv.version,
        mv.algorithm,
        mv.stage,
        mv.artifact_checksum,
        mv.training_rows,
        mv.training_window_start,
        mv.training_window_end,
        mv.validation_metrics,
        mv.feature_schema,
        mv.trained_at,
        mv.promoted_at
      FROM model_versions mv
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY mv.trained_at DESC, mv.id DESC
      LIMIT $${parameters.length}
    `, parameters);

    if (versions.rows.length === 0) {
      return [];
    }

    const activityByVersion = await this.loadPredictionActivity(versions.rows.map((row) => row.id));

    return versions.rows.map((row) => buildModelVersionPerformance({
      id: row.id,
      modelKey: row.model_key,
      version: asFiniteNumber(row.version, "model version"),
      algorithm: row.algorithm,
      stage: asModelStage(row.stage),
      artifactChecksum: row.artifact_checksum,
      trainingRows: asFiniteNumber(row.training_rows, "model training rows"),
      trainingWindowStart: asDate(row.training_window_start, "model training window start"),
      trainingWindowEnd: asDate(row.training_window_end, "model training window end"),
      trainedAt: asDate(row.trained_at, "model trained at"),
      promotedAt: row.promoted_at === null ? null : asDate(row.promoted_at, "model promoted at"),
      featureSchema: asFeatureSchema(row.feature_schema),
      storedMetrics: asMetricsEnvelope(row.validation_metrics),
      predictionActivity: activityByVersion.get(row.id) ?? emptyPredictionActivity(),
    }));
  }

  /**
   * Counts the research predictions already persisted for each version.
   *
   * This is observed usage of the model, not a claim about the model being right:
   * a realised-accuracy figure would need each prediction's forward outcome, and
   * inventing one here would misrepresent the registry.
   */
  private async loadPredictionActivity(versionIds: string[]): Promise<Map<string, ModelPredictionActivity>> {
    const [totals, labels] = await Promise.all([
      this.database.query<PredictionActivityRow>(`
        SELECT
          model_version_id,
          COUNT(*) AS prediction_count,
          AVG(confidence) AS average_confidence,
          MIN(created_at) AS first_prediction_at,
          MAX(created_at) AS last_prediction_at
        FROM model_predictions
        WHERE model_version_id = ANY($1::uuid[])
        GROUP BY model_version_id
      `, [versionIds]),
      this.database.query<PredictionActivityRow>(`
        SELECT model_version_id, prediction, COUNT(*) AS label_count
        FROM model_predictions
        WHERE model_version_id = ANY($1::uuid[])
        GROUP BY model_version_id, prediction
      `, [versionIds]),
    ]);

    const byVersion = new Map<string, ModelPredictionActivity>();
    for (const row of totals.rows) {
      const activity = emptyPredictionActivity();
      activity.predictionCount = asFiniteNumber(row.prediction_count, "prediction count");
      activity.averageConfidence = row.average_confidence === null
        ? null
        : asFiniteNumber(row.average_confidence, "average prediction confidence");
      activity.firstPredictionAt = row.first_prediction_at === null
        ? null
        : asDate(row.first_prediction_at, "first prediction at");
      activity.lastPredictionAt = row.last_prediction_at === null
        ? null
        : asDate(row.last_prediction_at, "last prediction at");
      byVersion.set(row.model_version_id, activity);
    }
    for (const row of labels.rows) {
      const activity = byVersion.get(row.model_version_id);
      if (activity && (modelPredictionLabels as readonly string[]).includes(row.prediction)) {
        activity.labelCounts[row.prediction] = asFiniteNumber(row.label_count, "prediction label count");
      }
    }

    return byVersion;
  }
}
