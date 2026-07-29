import type { PatternDirection, PriceActionEventCode, PriceActionEventRepository } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresPriceActionEventRepository implements PriceActionEventRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: {
    candleId: string;
    eventCode: PriceActionEventCode;
    direction: PatternDirection;
    level: number | null;
    confidence: number;
    algorithmVersion: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(`
      INSERT INTO price_action_events (
        candle_id, event_type, direction, level, confidence, algorithm_version, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (candle_id, event_type, algorithm_version) DO UPDATE SET
        direction = EXCLUDED.direction,
        level = EXCLUDED.level,
        confidence = EXCLUDED.confidence,
        details = EXCLUDED.details,
        detected_at = CURRENT_TIMESTAMP
    `, [
      input.candleId,
      input.eventCode,
      input.direction,
      input.level,
      input.confidence,
      input.algorithmVersion,
      JSON.stringify(input.details),
    ]);
  }
}
