import type { DatabaseQueryable } from "../database.js";

function asDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

/**
 * When each model family last produced an artifact.
 *
 * Read by the EOD training plan's cadence gate. The whole table is returned rather than filtered
 * by a `LIKE` prefix per configuration: `model_versions` holds a few hundred rows, the caller
 * already owns the prefix rules, and matching in TypeScript keeps SQL wildcard escaping out of a
 * path where the patterns are assembled from symbol and algorithm names.
 *
 * Every stage counts, not just PRODUCTION. The question the gate asks is "has this configuration
 * been fitted recently", and a CANDIDATE or REJECTED row answers it — a rejected candidate still
 * consumed the fit, and filtering to PRODUCTION would refit nightly for as long as a
 * configuration kept failing its gate, which is exactly the churn the cadence exists to stop.
 */
export class PostgresModelTrainingRecencyRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async getLatestTrainedAtByModelKey(): Promise<Map<string, Date>> {
    const result = await this.database.query<{ model_key: string; latest_trained_at: Date | string }>(
      `SELECT model_key, MAX(trained_at) AS latest_trained_at
         FROM model_versions
        GROUP BY model_key`,
    );
    return new Map(result.rows.map((row) => [
      row.model_key,
      asDate(row.latest_trained_at, "model trained at"),
    ]));
  }

  /**
   * Return volatility PRIMARY keys whose rolling live score has materially degraded.
   *
   * This mirrors the competition's evidence floors and dual baseline gate: at least 15 scored
   * sessions and 60 predictions in the last 30 days, then both accuracy and macro-F1 must beat an
   * always-majority predictor. Historical challengers cannot keep training permanently hot.
   */
  async getDegradedVolatilityModelKeys(): Promise<Set<string>> {
    const result = await this.database.query<{ model_key: string }>(`
      WITH labels(label) AS (
        VALUES ('CONTRACTION'), ('STABLE'), ('EXPANSION')
      ),
      settled AS (
        SELECT
          amp.model_version_id,
          amp.prediction,
          amp.realized_label,
          (amp.label_available_at AT TIME ZONE 'Asia/Kolkata')::date AS scored_date
        FROM auxiliary_model_predictions amp
        WHERE amp.label_scheme = 'volatility-expansion-v1'
          AND amp.settled_at IS NOT NULL
          AND amp.realized_label IN ('CONTRACTION', 'STABLE', 'EXPANSION')
          AND amp.prediction IN ('CONTRACTION', 'STABLE', 'EXPANSION')
          AND amp.label_available_at >= NOW() - INTERVAL '30 days'
      ),
      totals AS (
        SELECT
          model_version_id,
          count(*) AS sample_count,
          count(*) FILTER (WHERE prediction = realized_label) AS correct_count,
          count(DISTINCT scored_date) AS scored_days
        FROM settled
        GROUP BY model_version_id
      ),
      per_class AS (
        SELECT
          model.model_version_id,
          labels.label,
          count(*) FILTER (WHERE s.prediction = labels.label AND s.realized_label = labels.label) AS true_positive,
          count(*) FILTER (WHERE s.prediction = labels.label) AS predicted_count,
          count(*) FILTER (WHERE s.realized_label = labels.label) AS realized_count
        FROM (SELECT DISTINCT model_version_id FROM settled) model
        CROSS JOIN labels
        JOIN settled s ON s.model_version_id = model.model_version_id
        GROUP BY model.model_version_id, labels.label
      ),
      metrics AS (
        SELECT
          pc.model_version_id,
          SUM(
            CASE WHEN pc.predicted_count + pc.realized_count = 0 THEN 0
                 ELSE (2.0 * pc.true_positive) / (pc.predicted_count + pc.realized_count)
            END
          ) / 3.0 AS macro_f1,
          MAX(pc.realized_count)::numeric / MAX(t.sample_count) AS trivial_accuracy
        FROM per_class pc
        JOIN totals t ON t.model_version_id = pc.model_version_id
        GROUP BY pc.model_version_id
      )
      SELECT mv.model_key
      FROM volatility_competition_state vcs
      JOIN model_versions mv ON mv.id = vcs.model_version_id
      JOIN totals t ON t.model_version_id = mv.id
      JOIN metrics m ON m.model_version_id = mv.id
      WHERE vcs.label_scheme = 'volatility-expansion-v1'
        AND vcs.role = 'PRIMARY'
        AND t.sample_count >= 60
        AND t.scored_days >= 15
        AND (
          t.correct_count::numeric / t.sample_count <= m.trivial_accuracy
          OR m.macro_f1 <= (2.0 * m.trivial_accuracy) / (1.0 + m.trivial_accuracy) / 3.0
        )
    `);
    return new Set(result.rows.map((row) => row.model_key));
  }
}
