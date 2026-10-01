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

  /**
   * The traded option's own observed bid series over the holding period.
   *
   * This exists because `findHoldingPeriodCandles` is the wrong source for an option trade and was
   * being used for one. `paper_trades.instrument_id` points at the *index*, while `entry_price` and
   * `stop_loss` are *option premiums*, so excursions were comparing index levels to option prices --
   * 339 reviews reporting up to 10,697R favourable and exactly zero adverse. There are no candles for
   * an option contract; the premium tick series is the only price history it has.
   *
   * ## Direction of the bound flips, and that matters when reading the number
   *
   * Candle-derived excursions are an **upper** bound: a bar's full range is attributed to the
   * position even though the intrabar path is unknown. Tick-derived excursions are a **lower** bound:
   * the extremes between two samples are simply not observed, and this book is sampled roughly twice
   * a minute. So a tick-derived MAE of 0.4R means "at least 0.4R", where a candle-derived one meant
   * "at most". `observedTimeframe` is recorded as `tick` so a reader can tell which they hold.
   *
   * Only the bid is read, and non-positive bids are skipped -- the same rule the exit scan uses. A
   * long option is exited by selling into the bid, so it is the executable price, and a missing bid
   * means no buyer was quoted rather than a premium of zero.
   *
   * Empty for any trade closed before 2026-08-12, when premium tick collection began. That returns
   * `NO_SERIES` and the review states its excursions are unmeasured, which is the honest answer.
   */
  async findOptionPremiumSeries(input: {
    underlyingSymbol: string;
    expiryDate: Date;
    strikePrice: number;
    optionType: "CE" | "PE";
    openedAt: Date;
    closedAt: Date;
  }): Promise<HoldingPeriodCandles> {
    const result = await this.client.query<{ observed_at: Date; bid: string }>(`
      SELECT observed_at, bid
      FROM option_premium_ticks
      WHERE underlying_symbol = $1
        AND expiry_date = $2::date
        AND strike_price = $3
        AND option_type = $4
        AND observed_at >= $5
        AND observed_at <= $6
        AND bid IS NOT NULL
        AND bid > 0
      ORDER BY observed_at ASC
    `, [
      input.underlyingSymbol.toUpperCase(),
      input.expiryDate.toISOString().slice(0, 10),
      input.strikePrice,
      input.optionType,
      input.openedAt,
      input.closedAt,
    ]);

    if (result.rows.length === 0) return { candles: [], timeframe: null };
    return {
      timeframe: "tick",
      // A quote is an instant, not a range, so high and low are the same number. Writing it this way
      // reuses one excursion implementation rather than adding a parallel one for point series.
      candles: result.rows.map((row) => ({
        openTime: row.observed_at,
        high: Number(row.bid),
        low: Number(row.bid),
      })),
    };
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

  /**
   * Tag counts across reviews, optionally scoped to one instrument, one strategy, and/or the most
   * recent N matching closed trades -- the aggregate that may eventually justify an experiment.
   *
   * Unscoped (the default, no arguments), this is exactly the prior all-time global behaviour. That
   * matters here specifically: an online-adjustment rule reading "recent GAVE_BACK_FAVOURABLE_MOVE
   * tags" against the unscoped count would blend momentum-scalp's tags with every other strategy
   * this system has ever run, across all time -- a live risk decision has no business being moved by
   * a volatility-path option trade from months ago. Scoping this at the query layer, rather than by
   * adding columns to `trade_reviews`, reuses the FKs that already exist (`paper_trades.instrument_id`
   * is NOT NULL; `trade_ideas.evidence->>'strategy'` is the label strategies like `momentum-scalp`
   * already write -- see `momentum-scalp-strategy.ts`'s `evidence.strategy`) rather than duplicating
   * data that can be joined.
   */
  async countResearchTags(scope: ResearchTagScope = {}): Promise<Array<{ tag: string; tradeCount: number }>> {
    if (
      scope.recentTradeLimit !== undefined
      && (!Number.isInteger(scope.recentTradeLimit) || scope.recentTradeLimit <= 0)
    ) {
      throw new Error("recentTradeLimit must be a positive integer.");
    }

    const result = await this.client.query<{ tag: string; trade_count: string }>(`
      WITH scoped_reviews AS (
        SELECT trade_reviews.proposed_research_tags
        FROM trade_reviews
        JOIN paper_trades ON paper_trades.id = trade_reviews.trade_id
        LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
        WHERE ($1::uuid IS NULL OR paper_trades.instrument_id = $1)
          -- A trade with no linked idea, or an idea with no evidence.strategy, never matches a
          -- strategy filter: absence of the label stays absence rather than being silently included.
          AND ($2::text IS NULL OR trade_ideas.evidence->>'strategy' = $2)
        ORDER BY paper_trades.closed_at DESC
        -- LIMIT NULL is Postgres for "no limit", confirmed directly rather than assumed, so an
        -- omitted recentTradeLimit reproduces the prior unscoped, all-time behaviour exactly.
        LIMIT $3
      )
      SELECT tag, COUNT(*) AS trade_count
      FROM scoped_reviews, jsonb_array_elements_text(proposed_research_tags) AS tag
      GROUP BY tag
      ORDER BY COUNT(*) DESC, tag ASC
    `, [scope.instrumentId ?? null, scope.strategy ?? null, scope.recentTradeLimit ?? null]);
    return result.rows.map((row) => ({ tag: row.tag, tradeCount: Number(row.trade_count) }));
  }
}

export interface ResearchTagScope {
  /** Only trades on this instrument. Omit for every instrument. */
  readonly instrumentId?: string;
  /**
   * Only trades whose linked trade idea's evidence names this strategy (e.g. `"momentum-scalp"`,
   * the label `momentum-scalp-strategy.ts` writes into `evidence.strategy`). Omit for every strategy.
   */
  readonly strategy?: string;
  /**
   * Only the most recent N closed trades (by `paper_trades.closed_at`) matching the filters above.
   * Omit for an all-time count.
   */
  readonly recentTradeLimit?: number;
}
