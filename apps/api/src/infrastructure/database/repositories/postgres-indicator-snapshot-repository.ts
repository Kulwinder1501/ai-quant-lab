import type {
  IndicatorSnapshotInput,
  IndicatorSnapshotRepository,
} from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type { DatabaseQueryable } from "../database.js";

/**
 * Rows per statement. Postgres caps a statement at 65,535 bind parameters and each row
 * uses three, so the ceiling is 21,845; 500 keeps individual statements small enough that
 * one slow write does not hold a connection for long, and still turns a full NIFTY50 1m
 * recompute from ~810,000 round trips into ~1,600.
 */
const BATCH_SIZE = 500;

export class PostgresIndicatorSnapshotRepository implements IndicatorSnapshotRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsertMany(inputs: readonly IndicatorSnapshotInput[]): Promise<void> {
    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
      const batch = inputs.slice(start, start + BATCH_SIZE);
      const parameters: unknown[] = [];
      const tuples = batch.map((input, index) => {
        parameters.push(input.candleId, input.indicatorDefinitionId, JSON.stringify(input.values));
        const base = index * 3;
        return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
      });

      // A batch can carry the same (candle, definition) only once, so no intra-statement
      // conflict is possible -- the caller emits one point per candle per definition.
      await this.database.query(`
        INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values)
        VALUES ${tuples.join(", ")}
        ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET
          values = EXCLUDED.values,
          calculated_at = CURRENT_TIMESTAMP
      `, parameters);
    }
  }
}
