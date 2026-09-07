import type { CandleFeatureCoverageRepository } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

export class PostgresCandleFeatureCoverageRepository implements CandleFeatureCoverageRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * One set-based statement per layer, because the caller passes a whole write window.
   *
   * The intraday detection pass covers thousands of bars per invocation and already rescans the full
   * series -- 14s per instrument on 1m over ~56k bars, per the cadence note in `scheduler.ts`. A
   * per-row round trip here would be the same order of cost again for data that is pure bookkeeping.
   *
   * `computed_at` is deliberately left alone on conflict. It records when a layer *first* covered the
   * bar, which is the question the harness's read-ordering gate asks; a recompute pass re-covering
   * old history must not restamp it, or the column would degrade into the same
   * most-recent-write field that made `pattern_detections.detected_at` useless for this.
   */
  async record(input: {
    candleIds: readonly string[];
    featureLayer: string;
    algorithmVersion: string;
  }): Promise<void> {
    if (input.candleIds.length === 0) return;
    await this.database.query(`
      INSERT INTO candle_feature_coverage (candle_id, feature_layer, algorithm_version)
      SELECT candle_id, $2, $3 FROM UNNEST($1::uuid[]) AS candle_id
      ON CONFLICT (candle_id, feature_layer, algorithm_version) DO NOTHING
    `, [[...input.candleIds], input.featureLayer, input.algorithmVersion]);
  }
}
