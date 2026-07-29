import type { IndicatorSnapshotRepository, IndicatorValues } from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresIndicatorSnapshotRepository implements IndicatorSnapshotRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: { candleId: string; indicatorDefinitionId: string; values: IndicatorValues }): Promise<void> {
    await this.database.query(`
      INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET
        values = EXCLUDED.values,
        calculated_at = CURRENT_TIMESTAMP
    `, [input.candleId, input.indicatorDefinitionId, JSON.stringify(input.values)]);
  }
}
