import type { PatternDirection, PriceActionEventCode, PriceActionEventRepository } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresPriceActionEventRepository implements PriceActionEventRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * `detected_at` moves only when the row's content actually changes.
   *
   * Same fix and same reasoning as `PostgresPatternDetectionRepository.upsert` -- see its docstring.
   * This table is the more consequential of the two: the chart-pattern codes it carries (triangle,
   * wedge, head-and-shoulders, double top/bottom) are the ones whose underlying zigzag pivots can be
   * retroactively superseded by a later bar, so a stale-but-unmoving `detected_at` here was not just
   * hiding recent evidence from backtests but also letting revised evidence through an old cutoff
   * under a timestamp that no longer described when it became true.
   */
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
      WHERE
        price_action_events.direction IS DISTINCT FROM EXCLUDED.direction
        OR price_action_events.level IS DISTINCT FROM EXCLUDED.level
        OR price_action_events.confidence IS DISTINCT FROM EXCLUDED.confidence
        OR price_action_events.details IS DISTINCT FROM EXCLUDED.details
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
