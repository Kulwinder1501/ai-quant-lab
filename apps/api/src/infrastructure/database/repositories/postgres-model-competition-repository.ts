import {
  defaultCompetitionEligibilityFilter,
  type CompetitionEligibilityFilter,
} from "../../../modules/model-predictions/domain/competition-eligibility.js";
import type {
  CompetitionPoolRow,
  ModelCompetitionRepository,
} from "../../../modules/model-predictions/application/run-model-competition.js";
import type {
  ConfusionCell,
  DirectionalLabel,
  PromotionDecision,
  RoleAssignment,
} from "../../../modules/model-predictions/domain/model-competition.js";
import type { DatabasePool } from "../database.js";

export class PostgresModelCompetitionRepository implements ModelCompetitionRepository {
  constructor(private readonly database: DatabasePool) {}

  async listUnenrolledProductionModels(
    filter: CompetitionEligibilityFilter = defaultCompetitionEligibilityFilter,
  ): Promise<Array<{ modelVersionId: string; modelKey: string }>> {
    // Filtered on the label scheme and the feature-schema contract, not on stage alone.
    // Stage alone enrolled the non-directional volatility model as PRIMARY of a
    // BULLISH/BEARISH/NEUTRAL competition, where it had nothing to settle and could never
    // be replaced.
    const result = await this.database.query(`
      SELECT mv.id AS model_version_id, mv.model_key
      FROM model_versions mv
      WHERE mv.stage = 'PRODUCTION'
        AND (mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme') = ANY($1)
        AND (mv.validation_metrics ->> 'featureSchemaVersion') = $2
        AND NOT EXISTS (
          SELECT 1 FROM model_competition_state s
          WHERE s.competition_group = mv.model_key
        )
      ORDER BY mv.model_key
    `, [filter.directionalLabelSchemes, filter.featureSchemaVersion]);
    return result.rows.map((row) => {
      const record = row as { model_version_id: string; model_key: string };
      return { modelVersionId: record.model_version_id, modelKey: record.model_key };
    });
  }

  async listGrouplessCandidateModelKeys(input: {
    trainedAfter: Date;
    minimumHoldoutMacroF1: number;
    filter?: CompetitionEligibilityFilter;
  }): Promise<string[]> {
    const filter = input.filter ?? defaultCompetitionEligibilityFilter;
    // Same eligibility as the production path. Without the schema predicate this admitted
    // ml-feature-v1 and v4 candidates, which inference rejects, so they occupied pool slots
    // while being unable to produce a single prediction.
    const result = await this.database.query(`
      SELECT DISTINCT mv.model_key
      FROM model_versions mv
      WHERE mv.stage = 'CANDIDATE'
        AND mv.trained_at >= $1
        AND COALESCE((mv.validation_metrics -> 'validationMetrics' ->> 'macroF1')::numeric, 0) >= $2
        AND (mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme') = ANY($3)
        AND (mv.validation_metrics ->> 'featureSchemaVersion') = $4
        AND NOT EXISTS (
          SELECT 1 FROM model_competition_state s WHERE s.competition_group = mv.model_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM model_versions p WHERE p.model_key = mv.model_key AND p.stage = 'PRODUCTION'
        )
      ORDER BY mv.model_key
    `, [input.trainedAfter, input.minimumHoldoutMacroF1, filter.directionalLabelSchemes, filter.featureSchemaVersion]);
    return result.rows.map((row) => (row as { model_key: string }).model_key);
  }

  async enrollMember(
    modelVersionId: string,
    competitionGroup: string,
    role: "PRIMARY" | "COMPETITOR",
  ): Promise<void> {
    await this.database.query(`
      INSERT INTO model_competition_state (model_version_id, competition_group, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (model_version_id) DO NOTHING
    `, [modelVersionId, competitionGroup, role]);
  }

  async removeStaleUnscoredMembers(input: { enrolledBefore: Date }): Promise<number> {
    const result = await this.database.query(`
      DELETE FROM model_competition_state s
      WHERE s.role = 'COMPETITOR'
        AND s.enrolled_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM model_daily_scores d
          WHERE d.model_version_id = s.model_version_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM model_predictions p
          WHERE p.model_version_id = s.model_version_id AND p.settled_at IS NOT NULL
        )
    `, [input.enrolledBefore]);
    return result.rowCount ?? 0;
  }

  async listPool(): Promise<CompetitionPoolRow[]> {
    const result = await this.database.query(`
      SELECT s.model_version_id, s.competition_group, s.role
      FROM model_competition_state s
      ORDER BY s.competition_group, s.enrolled_at
    `);
    return result.rows.map((row) => {
      const record = row as {
        model_version_id: string;
        competition_group: string;
        role: "PRIMARY" | "SECONDARY" | "COMPETITOR";
      };
      return {
        modelVersionId: record.model_version_id,
        competitionGroup: record.competition_group,
        role: record.role,
      };
    });
  }

  async listEnrollableCandidates(input: {
    competitionGroup: string;
    trainedAfter: Date;
    minimumHoldoutMacroF1: number;
    limit: number;
  }): Promise<string[]> {
    // The entry gate reads the holdout macro-F1 the trainer persisted; it is a
    // sanity floor only — the title itself is decided on live settled outcomes.
    const result = await this.database.query(`
      SELECT mv.id
      FROM model_versions mv
      WHERE mv.model_key = $1
        AND mv.stage = 'CANDIDATE'
        AND mv.trained_at >= $2
        AND NOT EXISTS (
          SELECT 1 FROM model_competition_state s WHERE s.model_version_id = mv.id
        )
        AND COALESCE((mv.validation_metrics -> 'validationMetrics' ->> 'macroF1')::numeric, 0) >= $3
      ORDER BY mv.trained_at DESC
      LIMIT $4
    `, [input.competitionGroup, input.trainedAfter, input.minimumHoldoutMacroF1, input.limit]);
    return result.rows.map((row) => (row as { id: string }).id);
  }

  async listScoredDates(modelVersionIds: string[], limit: number): Promise<string[]> {
    if (modelVersionIds.length === 0) return [];
    const result = await this.database.query(`
      SELECT DISTINCT score_date::text AS score_date
      FROM model_daily_scores
      WHERE model_version_id = ANY($1::uuid[])
      ORDER BY score_date DESC
      LIMIT $2
    `, [modelVersionIds, limit]);
    return result.rows.map((row) => (row as { score_date: string }).score_date);
  }

  async settledConfusionForDates(modelVersionId: string, scoreDates: string[]): Promise<ConfusionCell[]> {
    if (scoreDates.length === 0) return [];
    const result = await this.database.query(`
      SELECT p.prediction, p.realized_label, COUNT(*)::int AS count
      FROM model_predictions p
      INNER JOIN candles c ON c.id = p.source_candle_id
      WHERE p.model_version_id = $1
        AND p.settled_at IS NOT NULL
        AND (c.close_time AT TIME ZONE 'Asia/Kolkata')::date = ANY($2::date[])
      GROUP BY p.prediction, p.realized_label
    `, [modelVersionId, scoreDates]);
    return result.rows.map((row) => {
      const record = row as {
        prediction: DirectionalLabel;
        realized_label: DirectionalLabel;
        count: number;
      };
      return { prediction: record.prediction, realizedLabel: record.realized_label, count: record.count };
    });
  }

  async listDailyMacroF1(modelVersionIds: string[], scoreDates: string[]): Promise<
    Array<{ modelVersionId: string; scoreDate: string; macroF1: number | null }>
  > {
    if (modelVersionIds.length === 0 || scoreDates.length === 0) return [];
    const result = await this.database.query(`
      SELECT model_version_id, score_date::text AS score_date, macro_f1
      FROM model_daily_scores
      WHERE model_version_id = ANY($1::uuid[])
        AND score_date = ANY($2::date[])
    `, [modelVersionIds, scoreDates]);
    return result.rows.map((row) => {
      const record = row as { model_version_id: string; score_date: string; macro_f1: string | null };
      return {
        modelVersionId: record.model_version_id,
        scoreDate: record.score_date,
        macroF1: record.macro_f1 === null ? null : Number(record.macro_f1),
      };
    });
  }

  async applyDecision(input: {
    competitionGroup: string;
    assignments: RoleAssignment[];
    promotion: PromotionDecision | null;
  }): Promise<void> {
    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;

      if (input.promotion) {
        // Stage swap ordered demote-then-promote: the one-PRODUCTION-per-key
        // partial unique index is checked per statement, so the incumbent must
        // vacate the slot first. The dethroned champion returns to CANDIDATE —
        // not ARCHIVED — because it stays in the pool and may win back the title.
        // An initial crowning (a group that never had a champion) has nobody to
        // demote.
        if (input.promotion.previousPrimaryId !== null) {
          const demoted = await client.query(`
            UPDATE model_versions
            SET stage = 'CANDIDATE'
            WHERE id = $1 AND stage = 'PRODUCTION'
          `, [input.promotion.previousPrimaryId]);
          if (demoted.rowCount !== 1) {
            throw new Error(
              `Competition promotion aborted: previous primary ${input.promotion.previousPrimaryId} is no longer PRODUCTION.`,
            );
          }
        }
        const promoted = await client.query(`
          UPDATE model_versions
          SET stage = 'PRODUCTION', promoted_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND stage = 'CANDIDATE'
        `, [input.promotion.newPrimaryId]);
        if (input.promotion.previousPrimaryId !== null && promoted.rowCount !== 1) {
          throw new Error(
            `Competition promotion aborted: challenger ${input.promotion.newPrimaryId} is not a CANDIDATE.`,
          );
        }
        // For an initial crowning a zero-row update just means the winner was
        // already PRODUCTION; only a real stage change earns an audit row.
        if (promoted.rowCount === 1) {
          await client.query(`
            INSERT INTO model_promotions (model_version_id, previous_model_version_id, comparison)
            VALUES ($1, $2, $3::jsonb)
          `, [
            input.promotion.newPrimaryId,
            input.promotion.previousPrimaryId,
            JSON.stringify({
              method: "DAILY_LIVE_COMPETITION_V1",
              decision: input.promotion.previousPrimaryId === null
                ? "INITIAL_LIVE_CROWNING"
                : "CHALLENGER_OUTPERFORMS_CHAMPION_LIVE",
              challengerRollingMacroF1: input.promotion.challengerRollingMacroF1,
              primaryRollingMacroF1: input.promotion.primaryRollingMacroF1,
              winsInWindow: input.promotion.winsInWindow,
              comparedDays: input.promotion.comparedDays,
              rules: input.promotion.rules,
            }),
          ]);
        }
      }

      // Roles rewritten in three passes (everyone → COMPETITOR, then SECONDARY,
      // then PRIMARY) because the one-PRIMARY / one-SECONDARY partial unique
      // indexes are checked per statement and per-member updates could collide
      // transiently.
      await client.query(`
        UPDATE model_competition_state
        SET role = 'COMPETITOR', last_evaluated_at = CURRENT_TIMESTAMP
        WHERE competition_group = $1
      `, [input.competitionGroup]);
      const secondary = input.assignments.find((entry) => entry.role === "SECONDARY");
      if (secondary) {
        await client.query(`
          UPDATE model_competition_state SET role = 'SECONDARY' WHERE model_version_id = $1
        `, [secondary.modelVersionId]);
      }
      const primary = input.assignments.find((entry) => entry.role === "PRIMARY");
      if (primary) {
        await client.query(`
          UPDATE model_competition_state SET role = 'PRIMARY' WHERE model_version_id = $1
        `, [primary.modelVersionId]);
      }
      for (const assignment of input.assignments) {
        await client.query(`
          UPDATE model_competition_state
          SET last_rolling_macro_f1 = $2
          WHERE model_version_id = $1
        `, [assignment.modelVersionId, assignment.rollingMacroF1]);
      }

      await client.query("COMMIT");
      transactionStarted = false;
    } finally {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      client.release();
    }
  }
}
