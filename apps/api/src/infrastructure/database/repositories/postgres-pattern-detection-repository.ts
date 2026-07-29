import type { PatternDetectionRepository, PatternDirection } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresPatternDetectionRepository implements PatternDetectionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: {
    candleId: string;
    patternDefinitionId: string;
    direction: PatternDirection;
    confidence: number;
    contextCandleIds: string[];
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(`
      INSERT INTO pattern_detections (
        candle_id, pattern_definition_id, direction, confidence, context_candle_ids, details
      ) VALUES ($1, $2, $3, $4, $5::uuid[], $6::jsonb)
      ON CONFLICT (candle_id, pattern_definition_id) DO UPDATE SET
        direction = EXCLUDED.direction,
        confidence = EXCLUDED.confidence,
        context_candle_ids = EXCLUDED.context_candle_ids,
        details = EXCLUDED.details,
        detected_at = CURRENT_TIMESTAMP
    `, [
      input.candleId,
      input.patternDefinitionId,
      input.direction,
      input.confidence,
      input.contextCandleIds,
      JSON.stringify(input.details),
    ]);
  }
}
