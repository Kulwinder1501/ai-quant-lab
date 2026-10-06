import type { PatternDetectionRepository, PatternDirection } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresPatternDetectionRepository implements PatternDetectionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * `detected_at` moves only when the row's content actually changes.
   *
   * The scheduled job rescans the full candle series and rewrites the trailing write window every
   * 15 minutes (see `scheduler.ts`'s `PATTERN_DETECTION_INTRADAY`). Before this fix, `detected_at`
   * was bumped to `CURRENT_TIMESTAMP` on every one of those rewrites regardless of whether anything
   * changed, which broke the one thing this column exists for: the backtest reader filters
   * `detected_at <= dataCutoffAt` specifically to keep evidence point-in-time
   * (`postgres-backtest-market-data-repository.ts`). A row rewritten every 15 minutes always has a
   * `detected_at` close to wall-clock "now", so a backtest with a `dataCutoffAt` inside the last few
   * days' rolling window saw almost none of this evidence -- confirmed live 2026-09-22: a candle
   * from 2026-09-21 had `detected_at` values spanning 04:15 to 10:35 the *next* day, six-plus hours
   * of rewrites with nothing about that candle having changed.
   *
   * The `WHERE` clause below makes the `DO UPDATE` a no-op when nothing changed, so `detected_at`
   * keeps reflecting first detection. It still advances -- correctly -- when this pattern's
   * classification for this candle genuinely was revised by later bars (the zigzag pivot list in
   * `zigzag-engine.ts` can retroactively supersede an earlier pivot), which is exactly the case
   * where a fresh `detected_at` is right: that revision used information the original detection
   * didn't have, and a past `dataCutoffAt` should no longer see it as point-in-time.
   */
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
      WHERE
        pattern_detections.direction IS DISTINCT FROM EXCLUDED.direction
        OR pattern_detections.confidence IS DISTINCT FROM EXCLUDED.confidence
        OR pattern_detections.context_candle_ids IS DISTINCT FROM EXCLUDED.context_candle_ids
        OR pattern_detections.details IS DISTINCT FROM EXCLUDED.details
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
