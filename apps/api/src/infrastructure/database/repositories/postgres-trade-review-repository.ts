import type { DatabaseClient } from "../database.js";
import type { TradeReview, TradeReviewCandle } from "../../../modules/paper-trading/domain/trade-review.js";

export interface HoldingPeriodCandles {
  candles: TradeReviewCandle[];
  timeframe: string | null;
}

/**
 * Finest first. Excursions read from candle extremes are an upper bound on the real
 * adverse and favourable moves, and the coarser the candle the looser that bound: a
 * single daily bar containing a whole trade reports its full range as excursion. So
 * the finest timeframe that actually covers the holding period is preferred, and
 * whichever is used is recorded on the review.
 *
 * `60m` replaced `1h` here on 2026-08-03, and `30m` was added. `1h` is not a member of
 * `supportedHistoricalTimeframes`, so no collector can produce it — the only rows that
 * ever carried it came from `seed-market-data.ts`. This ladder was therefore looking for
 * 98 seed bars across two instruments while 78,000 real `60m` bars existed under the
 * canonical name, and falling through to `1d` whenever those seed bars did not cover the
 * holding period. `30m` was simply missing despite 11,846 stored bars.
 */
const TIMEFRAME_PRECISION_ORDER = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"] as const;

export class PostgresTradeReviewRepository {
  constructor(private readonly client: DatabaseClient) {}

  /**
   * Candles overlapping the holding period, at the finest timeframe that has any.
   *
   * A candle qualifies when it overlaps `[openedAt, closedAt]` rather than being
   * contained by it, because the bars holding the entry and the exit are exactly the
   * ones most likely to contain the extremes.
   */
  async findHoldingPeriodCandles(input: {
    instrumentId: string;
    openedAt: Date;
    closedAt: Date;
    preferredTimeframe?: string | null;
  }): Promise<HoldingPeriodCandles> {
    const ordered = input.preferredTimeframe
      ? [input.preferredTimeframe, ...TIMEFRAME_PRECISION_ORDER.filter((tf) => tf !== input.preferredTimeframe)]
      : [...TIMEFRAME_PRECISION_ORDER];

    for (const timeframe of ordered) {
      const result = await this.client.query<{ open_time: Date; high: string; low: string }>(`
        SELECT open_time, high, low
        FROM candles
        WHERE instrument_id = $1
          AND timeframe = $2
          AND is_complete
          AND open_time <= $4
          AND close_time >= $3
        ORDER BY open_time ASC
      `, [input.instrumentId, timeframe, input.openedAt, input.closedAt]);

      if (result.rows.length > 0) {
        return {
          timeframe,
          candles: result.rows.map((row) => ({
            openTime: row.open_time,
            high: Number(row.high),
            low: Number(row.low),
          })),
        };
      }
    }

    // Reported rather than papered over: a review with no candles states that its
    // excursions are unmeasured instead of presenting zero as a measurement.
    return { candles: [], timeframe: null };
  }

  async save(review: TradeReview): Promise<void> {
    await this.client.query(`
      INSERT INTO trade_reviews (
        trade_id, outcome, exit_reason, realized_pnl, risk_per_unit, realized_r,
        maximum_adverse_excursion, maximum_favourable_excursion,
        maximum_adverse_excursion_r, maximum_favourable_excursion_r,
        candles_observed, observed_timeframe, observations, proposed_research_tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
      ON CONFLICT (trade_id) DO UPDATE SET
        outcome = EXCLUDED.outcome,
        exit_reason = EXCLUDED.exit_reason,
        realized_pnl = EXCLUDED.realized_pnl,
        risk_per_unit = EXCLUDED.risk_per_unit,
        realized_r = EXCLUDED.realized_r,
        maximum_adverse_excursion = EXCLUDED.maximum_adverse_excursion,
        maximum_favourable_excursion = EXCLUDED.maximum_favourable_excursion,
        maximum_adverse_excursion_r = EXCLUDED.maximum_adverse_excursion_r,
        maximum_favourable_excursion_r = EXCLUDED.maximum_favourable_excursion_r,
        candles_observed = EXCLUDED.candles_observed,
        observed_timeframe = EXCLUDED.observed_timeframe,
        observations = EXCLUDED.observations,
        proposed_research_tags = EXCLUDED.proposed_research_tags
    `, [
      review.tradeId,
      review.outcome,
      review.exitReason,
      review.realizedPnl,
      review.riskPerUnit,
      review.realizedR,
      review.maximumAdverseExcursion,
      review.maximumFavourableExcursion,
      review.maximumAdverseExcursionR,
      review.maximumFavourableExcursionR,
      review.candlesObserved,
      review.observedTimeframe,
      JSON.stringify(review.observations),
      JSON.stringify(review.proposedResearchTags),
    ]);
  }

  /** Tag counts across reviews -- the aggregate that may eventually justify an experiment. */
  async countResearchTags(): Promise<Array<{ tag: string; tradeCount: number }>> {
    const result = await this.client.query<{ tag: string; trade_count: string }>(`
      SELECT tag, COUNT(*) AS trade_count
      FROM trade_reviews, jsonb_array_elements_text(proposed_research_tags) AS tag
      GROUP BY tag
      ORDER BY COUNT(*) DESC, tag ASC
    `);
    return result.rows.map((row) => ({ tag: row.tag, tradeCount: Number(row.trade_count) }));
  }
}
