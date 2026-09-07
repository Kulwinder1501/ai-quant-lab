import type { Express, Request } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { InvalidHttpQueryError, parseLimit, queryString } from "../../../../interfaces/http/common/query.js";
import { InvalidModelPerformanceQueryError } from "../../application/list-model-versions.js";
import type { ModelStage } from "../../../model-predictions/domain/model-prediction.js";

function parseModelVersionQuery(request: Request): {
  modelKey?: string;
  algorithm?: string;
  stage?: ModelStage;
  limit?: number;
} {
  return {
    modelKey: queryString(request, "modelKey"),
    algorithm: queryString(request, "algorithm"),
    stage: queryString(request, "stage")?.toUpperCase() as ModelStage | undefined,
    limit: parseLimit(request),
  };
}

export function registerModelPerformanceRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "database" | "listModelVersions">,
): void {
  app.get("/api/v1/model-versions", async (request, response, next) => {
    try {
      const result = await dependencies.listModelVersions.execute(parseModelVersionQuery(request));
      response.status(200).json({
        data: result.records,
        families: result.families,
        page: { limit: result.limit, truncated: result.truncated },
        context: { researchOnly: true },
      });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidModelPerformanceQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/models/competition", async (_request, response, next) => {
    try {
      const stateResult = await dependencies.database.query(`
        SELECT
          s.competition_group, s.role, s.model_version_id, s.enrolled_at,
          s.last_rolling_macro_f1, s.last_evaluated_at, mv.model_key,
          mv.version, mv.algorithm, mv.stage, mv.trained_at, mv.promoted_at
        FROM model_competition_state s
        INNER JOIN model_versions mv ON mv.id = s.model_version_id
        ORDER BY s.competition_group,
          CASE s.role WHEN 'PRIMARY' THEN 0 WHEN 'SECONDARY' THEN 1 ELSE 2 END,
          s.last_rolling_macro_f1 DESC NULLS LAST, s.enrolled_at
      `);
      const memberIds = stateResult.rows.map(
        (row: Record<string, unknown>) => (row as { model_version_id: string }).model_version_id,
      );
      const scoresResult = memberIds.length === 0
        ? { rows: [] as unknown[] }
        : await dependencies.database.query(`
            SELECT model_version_id, score_date::text AS score_date,
              predictions_settled, predictions_correct, accuracy, macro_f1,
              directional_hit_rate
            FROM model_daily_scores
            WHERE model_version_id = ANY($1::uuid[])
              AND score_date >= CURRENT_DATE - INTERVAL '14 days'
            ORDER BY score_date DESC
          `, [memberIds]);
      const promotionsResult = await dependencies.database.query(`
        SELECT p.model_version_id, p.previous_model_version_id, p.comparison,
          p.promoted_at, mv.model_key, mv.version
        FROM model_promotions p
        INNER JOIN model_versions mv ON mv.id = p.model_version_id
        ORDER BY p.promoted_at DESC
        LIMIT 10
      `);
      response.status(200).json({
        data: { pool: stateResult.rows, dailyScores: scoresResult.rows, promotions: promotionsResult.rows },
        context: { researchOnly: true },
      });
    } catch (error) {
      next(error);
    }
  });
}
