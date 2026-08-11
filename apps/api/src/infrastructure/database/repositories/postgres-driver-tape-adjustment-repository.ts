import type { DatabaseQueryable } from "../database.js";
import type { DriverTapeMetrics } from "../../../modules/market-data/domain/driver-tape.js";

export interface DriverTapeAdjustmentInput {
  underlyingSymbol: string;
  thesisSide: "LONG" | "SHORT";
  adjustment: number;
  reasoning: string;
  metrics: DriverTapeMetrics | null;
  preAdjustmentConfidence: number | null;
  resultingConfidence: number | null;
  resultingSide: "LONG" | "SHORT" | null;
  thoughtId: string | null;
  sourceCandleId: string | null;
}

/**
 * Measurement log for soft driver-tape confidence adjustments.
 * Insert-only; never features for models.
 */
export class PostgresDriverTapeAdjustmentRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async insert(input: DriverTapeAdjustmentInput): Promise<string> {
    const metrics = input.metrics;
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO driver_tape_adjustments (
        underlying_symbol, thesis_side, adjustment, reasoning,
        advance_share, decline_share, concentration, coverage,
        quoted_count, roster_count, est_net_pts,
        pre_adjustment_confidence, resulting_confidence, resulting_side, thought_id,
        source_candle_id
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16
      )
      RETURNING id
    `, [
      input.underlyingSymbol,
      input.thesisSide,
      input.adjustment,
      input.reasoning,
      metrics?.advanceShare ?? null,
      metrics?.declineShare ?? null,
      metrics?.concentration ?? null,
      metrics?.coverage ?? null,
      metrics?.quotedCount ?? null,
      metrics?.rosterCount ?? null,
      metrics?.estNetPts ?? null,
      input.preAdjustmentConfidence,
      input.resultingConfidence,
      input.resultingSide,
      input.thoughtId,
      input.sourceCandleId,
    ]);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Driver-tape adjustment insert returned no id.");
    return id;
  }

  async linkToDecision(ids: readonly string[], tradeIdeaId: string, paperTradeId: string | null): Promise<void> {
    if (ids.length === 0) return;
    await this.database.query(`
      UPDATE driver_tape_adjustments
      SET trade_idea_id = $2, paper_trade_id = $3
      WHERE id = ANY($1::uuid[])
    `, [ids, tradeIdeaId, paperTradeId]);
  }
}
