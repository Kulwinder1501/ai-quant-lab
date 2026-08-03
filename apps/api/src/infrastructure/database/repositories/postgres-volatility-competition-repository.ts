import type { DatabasePool } from "../database.js";
import type {
  VolatilityCandidate,
  VolatilityCompetitionRepository,
  VolatilityRoleAssignment,
} from "../../../modules/model-predictions/application/run-volatility-competition.js";
import {
  isVolatilityLabel,
  type VolatilityLabel,
} from "../../../modules/model-predictions/domain/volatility-expansion-label.js";
import type { VolatilityRole } from "../../../modules/model-predictions/domain/volatility-competition.js";

const VOLATILITY_SCHEME = "volatility-expansion-v1";

export class PostgresVolatilityCompetitionRepository implements VolatilityCompetitionRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Every volatility model with its settled confusion counts over the rolling window.
   *
   * The window is measured on `label_available_at` — when the outcome became knowable —
   * not `settled_at`. Settling is a batch job that can run late or catch up, so keying
   * the window to it would let an operational delay reshape a model's scoreboard.
   *
   * Rows whose realised label is absent, or outside the volatility alphabet, are
   * excluded here and re-checked in code: a foreign label reaching this table would mean
   * the alphabets had crossed, and it must not be silently counted as a class.
   */
  async listCandidates(rollingWindowDays: number): Promise<VolatilityCandidate[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(rollingWindowDays), 365));
    const result = await this.pool.query(`
      SELECT
        mv.id                        AS model_version_id,
        mv.model_key,
        vcs.role,
        amp.prediction,
        amp.realized_label,
        count(*)                     AS cell_count,
        count(DISTINCT (amp.label_available_at AT TIME ZONE 'Asia/Kolkata')::date)
                                     AS scored_days,
        max((amp.label_available_at AT TIME ZONE 'Asia/Kolkata')::date)::text
                                     AS last_scored_date
      FROM model_versions mv
      LEFT JOIN volatility_competition_state vcs ON vcs.model_version_id = mv.id
      LEFT JOIN auxiliary_model_predictions amp
        ON amp.model_version_id = mv.id
       AND amp.settled_at IS NOT NULL
       AND amp.realized_label IS NOT NULL
       AND amp.label_available_at >= NOW() - ($1 || ' days')::interval
      WHERE (mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme') = $2
      GROUP BY mv.id, mv.model_key, vcs.role, amp.prediction, amp.realized_label
      ORDER BY mv.model_key
    `, [bounded, VOLATILITY_SCHEME]);

    const byModel = new Map<string, VolatilityCandidate>();
    for (const row of result.rows) {
      const modelVersionId = String(row.model_version_id);
      let candidate = byModel.get(modelVersionId);
      if (!candidate) {
        candidate = {
          modelVersionId,
          modelKey: String(row.model_key),
          role: (row.role as VolatilityRole | null) ?? null,
          cells: [],
          scoredDays: 0,
          lastScoredDate: null,
        };
        byModel.set(modelVersionId, candidate);
      }
      // A model with no settled rows still appears, via the LEFT JOIN, with null
      // prediction columns. It belongs in the candidate list so the competition can
      // report it as excluded rather than pretending it does not exist.
      if (row.prediction === null || row.realized_label === null) continue;
      const prediction = String(row.prediction);
      const realizedLabel = String(row.realized_label);
      if (!isVolatilityLabel(prediction) || !isVolatilityLabel(realizedLabel)) {
        throw new Error(
          `Model ${candidate.modelKey} has a settled row outside the volatility alphabet `
          + `(${prediction} -> ${realizedLabel}). The label alphabets have crossed.`,
        );
      }
      candidate.cells.push({
        prediction: prediction as VolatilityLabel,
        realizedLabel: realizedLabel as VolatilityLabel,
        count: Number(row.cell_count),
      });
      candidate.scoredDays = Math.max(candidate.scoredDays, Number(row.scored_days));
      const lastScored = row.last_scored_date === null ? null : String(row.last_scored_date);
      if (lastScored !== null && (candidate.lastScoredDate === null || lastScored > candidate.lastScoredDate)) {
        candidate.lastScoredDate = lastScored;
      }
    }
    return [...byModel.values()];
  }

  /**
   * Replaces all role rows for the scheme in one transaction.
   *
   * Delete-then-insert rather than upsert-and-prune: a partial update could leave two
   * PRIMARY rows momentarily, and the unique partial index would reject the second
   * insert while the first had already displaced the real champion. Clearing first makes
   * the whole assignment atomic, and `became_primary_at` is preserved for a model that
   * held the title before this run.
   */
  async applyRoles(input: {
    labelScheme: string;
    assignments: VolatilityRoleAssignment[];
    decisionReason: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT model_version_id, became_primary_at FROM volatility_competition_state WHERE label_scheme = $1",
        [input.labelScheme],
      );
      const priorPrimaryAt = new Map(
        existing.rows.map((row) => [String(row.model_version_id), row.became_primary_at as Date | null]),
      );

      await client.query("DELETE FROM volatility_competition_state WHERE label_scheme = $1", [input.labelScheme]);

      for (const assignment of input.assignments) {
        const becamePrimaryAt = assignment.role !== "PRIMARY"
          ? null
          : assignment.becamePrimary
            ? new Date()
            : priorPrimaryAt.get(assignment.modelVersionId) ?? new Date();
        await client.query(`
          INSERT INTO volatility_competition_state (
            model_version_id, label_scheme, role, became_primary_at, last_decision_reason, last_decision_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        `, [
          assignment.modelVersionId,
          input.labelScheme,
          assignment.role,
          becamePrimaryAt,
          input.decisionReason,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
