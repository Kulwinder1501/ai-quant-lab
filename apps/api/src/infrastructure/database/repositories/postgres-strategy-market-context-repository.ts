import type { QueryResultRow } from "pg";
import type { IndicatorCode, IndicatorValues } from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type {
  CandlestickPatternCode,
  PatternDirection,
  PriceActionEventCode,
} from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type {
  ConfluenceSignal,
  StrategyMarketContext,
  StrategyMarketContextRepository,
} from "../../../modules/strategy-engine/domain/strategy.js";
import { ictContextConsumedAt } from "../../../modules/strategy-engine/domain/strategy-registry.js";
import {
  deriveVolatilityRegime,
  regimeSourceIndicatorAlgorithmVersion,
  regimeSourceIndicatorCode,
  regimeSourceIndicatorPeriod,
  regimeSourceInstrumentSymbol,
  regimeStalenessMilliseconds,
  type RegimeContext,
} from "../../../modules/strategy-engine/domain/regime.js";
import type { DatabaseQueryable } from "../database.js";
import { IctCompositeEngine } from "../../../modules/technical-analysis/domain/ict/composite-engine.js";
import { instrumentProfileForSymbol } from "../../../modules/platform/calendar/instrument-profile.js";
import { ICT_STATE_ENGINE_VERSION, computeIctConfigHash, defaultIctEngineConfig, type IctStateCompositeSnapshot } from "../../../modules/technical-analysis/domain/ict/config.js";
import { computeHtfBucketBiases, mapBarsToHtfBias, type HtfSourceCandle } from "../../../modules/technical-analysis/domain/ict/replay-builder.js";
import {
  DI_STANDARDISATION_WINDOW_MINUTES,
  calculateDecayingDepthImbalance,
  istSessionStart,
  resolveConfluenceSignalFromDepth,
  trailingSessionMinuteDiSamples,
} from "../../../modules/strategy-engine/domain/orderbook-directional-gate.js";
import {
  DEPTH_FRAME_MAX_AGE_MS,
  buildOptionChainSignal,
  selectNearestUnsettledExpiry,
  unavailableOptionChainSignal,
  type OptionChainSignal,
} from "../../../modules/strategy-engine/domain/option-chain-signal.js";
import {
  frontMonthFuturesSymbol,
  futuresTickerUnderlying,
} from "../../../modules/market-data/domain/depth-frame-staleness.js";


interface CompletedCandleRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  timeframe: string;
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tick_size: string;
  /** From the same `instruments` join that already supplies `tick_size` -- see `instrumentProfileForSymbol`. */
  symbol: string;
}

interface IndicatorSnapshotRow extends QueryResultRow {
  indicator_code: IndicatorCode;
  algorithm_version: string;
  parameters: Record<string, unknown>;
  values: IndicatorValues;
}

interface PatternDetectionRow extends QueryResultRow {
  pattern_code: CandlestickPatternCode;
  algorithm_version: string;
  direction: PatternDirection;
  confidence: string;
  context_candle_ids: string[];
  details: Record<string, unknown>;
}

interface PriorDepthTotalsRow extends QueryResultRow {
  received_at: Date;
  total_buy_qty: string | null;
  total_sell_qty: string | null;
}

interface DepthFrameRow extends QueryResultRow {
  /** Optional only because older fakes omit it; the real query always selects it. */
  received_at?: Date;
  bid_price: string[];
  bid_qty: string[];
  ask_price: string[];
  ask_qty: string[];
  total_buy_qty: string | null;
  total_sell_qty: string | null;
}

interface PriceActionEventRow extends QueryResultRow {
  event_type: PriceActionEventCode;
  algorithm_version: string;
  direction: PatternDirection;
  level: string | null;
  confidence: string;
  details: Record<string, unknown>;
}

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid numeric ${field}.`);
  }
  return parsed;
}

function toCandle(row: CompletedCandleRow): StrategyMarketContext["candle"] {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    timeframe: row.timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: toNumber(row.open, "candle open"),
    high: toNumber(row.high, "candle high"),
    low: toNumber(row.low, "candle low"),
    close: toNumber(row.close, "candle close"),
    volume: toNumber(row.volume, "candle volume"),
    tickSize: toNumber(row.tick_size, "instrument tick size"),
  };
}

/** Reads only completed-candle evidence, so strategy decisions cannot use a forming bar. */
let ictPersistGrantWarned = false;

// The option-chain staleness ceiling (20 minutes, with the collector-cadence math) and every other
// PCR selection rule now live in `option-chain-signal.ts`, shared in intent with
// `apps/ml/oi_pcr_signal_check.py` and `apps/ml/run_hybrid_confluence_backtest.py`. The live gate
// used 15 minutes while the backtest used 60, so the validated gate was not the live gate.

/**
 * How many calendar days of trailing history feed the daily HTF-bias derivation
 * (`computeHtfBucketBiases`'s daily engine), independent of `computeAndPersistIctSnapshot`'s
 * 1000-row cap below.
 *
 * The 1000-row cap exists for the EXECUTION-timeframe pillars (structure/zones/session-levels/
 * liquidity), which need BARS, not calendar days. The HTF pillar aggregates into DAILY session
 * buckets and needs enough CALENDAR DAYS for `IctStructureTracker(pivotLength: 3)` to confirm its
 * first swing high and leave NEUTRAL -- 1000 base-timeframe rows is only ~40 calendar days for
 * NIFTY50 15m and ~13 for BANKNIFTY 5m, which measured live (2026-09-21 .. 2026-09-30) as
 * `coverage.htf === "COMPLETE"` on only 22-25% of bars for NIFTY50 and 0/587 for BANKNIFTY --
 * most of that trailing window never reached far enough into a calendar-day series to resolve a
 * swing at all.
 *
 * 400 is empirically derived, not guessed: replaying the real daily-bucketed OWN_STRUCTURE engine
 * against every NIFTY50 15m and BANKNIFTY 5m candle in the live database (2023-01-02 ..
 * 2026-09-30), from 13 different sliding-window start points spanning that whole history,
 * resolved out of NEUTRAL within 11-39 calendar days every single time (worst case: BANKNIFTY, 39
 * days). 400 is roughly 10x that worst case -- a real margin, not a round number -- while staying
 * well short of "fetch the entire multi-year history on every live bar", which profiled at a real
 * but needless ~250ms (query + daily-engine replay) against NIFTY50's full 929-bucket, 3.75-year
 * history vs. ~30-50ms for a 400-day window. Recomputed from scratch on every call rather than
 * cached: `computeAndPersistIctSnapshot` only runs once per NEW completed candle (a cache-fill --
 * see the class doc comment above `persistIctSnapshot`), so at NIFTY50's 15m/BANKNIFTY's 5m
 * cadence that is at most ~25-75 calls/day, each comfortably sub-100ms end to end. That call
 * volume and per-call cost don't justify a stateful memoization layer; see the falsification
 * program notes for the real profiling numbers this constant is based on.
 */
const HTF_BIAS_LOOKBACK_CALENDAR_DAYS = 400;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A defensive ceiling on the HTF-bias history fetch, unrelated to the 400-day calendar window
 * above: it exists only so a future registered ICT strategy at a much finer timeframe (e.g. 1m)
 * cannot turn "400 calendar days" into an unbounded row scan. 50,000 rows is already far more
 * than 400 days could produce even at 1m granessularity during regular NSE hours (~375 bars/day
 * x 400 = 150,000 bars would exceed it -- and no ICT strategy is registered at 1m today).
 */
const HTF_BIAS_HISTORY_ROW_CEILING = 50_000;

export class PostgresStrategyMarketContextRepository implements StrategyMarketContextRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async findLatestCompleted(input: { instrumentId: string; timeframe: string }): Promise<StrategyMarketContext | null> {
    const candleResult = await this.database.query<CompletedCandleRow>(`
      SELECT
        candles.id,
        candles.instrument_id,
        candles.timeframe,
        candles.open_time,
        candles.close_time,
        candles.open,
        candles.high,
        candles.low,
        candles.close,
        candles.volume,
        instruments.tick_size,
        instruments.symbol
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = $1
        AND candles.timeframe = $2
        AND candles.is_complete = TRUE
        -- Yahoo historical imports mark the still-open session bar complete; its
        -- close_time is still in the future. Strategies evaluate only bars whose
        -- close has already elapsed, matching the market-scanner settled-bar rule.
        AND candles.close_time <= CURRENT_TIMESTAMP
      ORDER BY candles.close_time DESC, candles.open_time DESC
      LIMIT 1
    `, [input.instrumentId, input.timeframe]);
    const candle = candleResult.rows[0];
    if (!candle) {
      return null;
    }
    return this.assembleContext(input, candle);
  }

  private async computeAndPersistIctSnapshot(
    input: { instrumentId: string; timeframe: string },
    targetCandle: CompletedCandleRow,
    configHash: string,
  ): Promise<IctStateCompositeSnapshot | undefined> {
    const htfCutoff = new Date(targetCandle.open_time.getTime() - HTF_BIAS_LOOKBACK_CALENDAR_DAYS * MILLISECONDS_PER_DAY);

    const [historyResult, htfHistoryResult] = await Promise.all([
      this.database.query<CompletedCandleRow>(`
        SELECT
          candles.id,
          candles.instrument_id,
          candles.timeframe,
          candles.open_time,
          candles.close_time,
          candles.open,
          candles.high,
          candles.low,
          candles.close,
          candles.volume,
          instruments.tick_size,
          instruments.symbol
        FROM candles
        INNER JOIN instruments ON instruments.id = candles.instrument_id
        WHERE candles.instrument_id = $1
          AND candles.timeframe = $2
          AND candles.is_complete = TRUE
          AND candles.open_time <= $3
        ORDER BY candles.open_time DESC
        LIMIT 1000
      `, [input.instrumentId, input.timeframe, targetCandle.open_time]),
      /*
       * Decoupled from the 1000-row cap above: see HTF_BIAS_LOOKBACK_CALENDAR_DAYS's doc comment
       * for why the HTF pillar needs its own, calendar-bounded (not row-bounded) history. Bounded
       * by DATE RANGE rather than row count, because calendar days -- not bar count -- is what the
       * daily-bucket structure classifier actually needs to mature.
       */
      this.database.query<CompletedCandleRow>(`
        SELECT
          candles.id,
          candles.instrument_id,
          candles.timeframe,
          candles.open_time,
          candles.close_time,
          candles.open,
          candles.high,
          candles.low,
          candles.close,
          candles.volume,
          instruments.tick_size,
          instruments.symbol
        FROM candles
        INNER JOIN instruments ON instruments.id = candles.instrument_id
        WHERE candles.instrument_id = $1
          AND candles.timeframe = $2
          AND candles.is_complete = TRUE
          AND candles.open_time <= $3
          AND candles.open_time >= $4
        ORDER BY candles.open_time ASC
        LIMIT $5
      `, [input.instrumentId, input.timeframe, targetCandle.open_time, htfCutoff, HTF_BIAS_HISTORY_ROW_CEILING]),
    ]);

    if (historyResult.rows.length === 0) return undefined;

    const rows = [...historyResult.rows].reverse();
    const causalCandles = rows.map((r) => ({
      id: r.id,
      openTime: r.open_time,
      closeTime: r.close_time,
      open: toNumber(r.open, "open"),
      high: toNumber(r.high, "high"),
      low: toNumber(r.low, "low"),
      close: toNumber(r.close, "close"),
      volume: toNumber(r.volume, "volume"),
    }));

    const htfSourceCandles: HtfSourceCandle[] = htfHistoryResult.rows.map((r) => ({
      id: r.id,
      openTime: r.open_time,
      closeTime: r.close_time,
      open: toNumber(r.open, "open"),
      high: toNumber(r.high, "high"),
      low: toNumber(r.low, "low"),
      close: toNumber(r.close, "close"),
      volume: toNumber(r.volume, "volume"),
    }));

    /*
     * The live path's own HTF bias derivation, ported from the replay builder: without this, Gate 1
     * (`ict-structure-strategy.ts`) demands `coverage.htf === "COMPLETE"` on every bar and never gets
     * it, because `engine.processCandle` below would otherwise never receive a bias at all --
     * `coverage.htf` would be NOT_COVERED on every single call, permanently.
     *
     * Bucket biases come from `htfSourceCandles` (the wide, calendar-bounded set); they are then
     * mapped onto `causalCandles` (the narrow, 1000-row-capped set) by close time. The two arrays
     * are not the same series and do not share indices, so alignment must go through `closeTime`,
     * never array position -- `mapBarsToHtfBias` does exactly that. See `computeHtfBucketBiases`
     * and `mapBarsToHtfBias`'s own doc comments for the session-bucketing rule itself.
     */
    const htfBucketBiases = computeHtfBucketBiases(htfSourceCandles, defaultIctEngineConfig);
    const htfBiasSeries = mapBarsToHtfBias(causalCandles, htfBucketBiases);

    /*
     * The one place G1's session-date resolver actually changes behaviour: `targetCandle.symbol`
     * comes straight off the `instruments` join (`instruments.symbol`, already selected alongside
     * `tick_size`), so XAU_USD gets its real DST-aware NY session boundary here instead of silently
     * inheriting NSE's fixed +5:30 one. Every NSE instrument resolves to `NSE_IST_PROFILE`, which
     * `instrument-profile.test.ts` proves byte-identical to the old `istSessionDate` behaviour this
     * engine always had -- see that file's "matches istSessionDate" cases.
     */
    const profile = instrumentProfileForSymbol(targetCandle.symbol);
    const engine = new IctCompositeEngine(defaultIctEngineConfig, profile);
    let snapshot: IctStateCompositeSnapshot | undefined;

    for (let i = 0; i < causalCandles.length; i++) {
      snapshot = engine.processCandle(causalCandles, i, htfBiasSeries[i]);
    }

    if (snapshot) {
      /*
       * The persist is a lazy cache-fill, not the result. `scalp_research_writer` holds SELECT and
       * only SELECT on this table by design (migration 076), so the research harness -- which calls
       * `assembleContext` on the same path -- died with 42501 on every decision point and took the
       * whole capture tick down with it.
       *
       * Only a missing write grant is tolerated, and only around the write. Anything else rethrows:
       * a malformed payload or a broken constraint is a real defect and must not be swallowed. The
       * computed snapshot is returned either way, so a reader without write access still gets the
       * correct ICT context -- it just does not get to populate the cache for everyone else.
       */
      try {
        await this.persistIctSnapshot(input, snapshot);
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "42501") throw error;
        if (!ictPersistGrantWarned) {
          ictPersistGrantWarned = true;
          console.warn(JSON.stringify({
            level: "warn",
            message: "No write grant on ict_state_snapshots; computing ICT context without caching it",
            hint: "Expected for the least-privilege scalp research role. Grant INSERT only if this "
              + "role is meant to populate the cache, which would widen migration 076's boundary.",
          }));
        }
      }
    }

    return snapshot;
  }

  private async persistIctSnapshot(
    input: { instrumentId: string; timeframe: string },
    snapshot: IctStateCompositeSnapshot,
  ): Promise<void> {
    {
      await this.database.query(`
        INSERT INTO ict_state_snapshots (
          instrument_id, timeframe, engine_version, config_hash,
          bar_index, bar_time, structure_trend, bias_direction, daily_template,
          dealing_range_eq, primary_target_price, primary_target_kind,
          invalidation_level, alignment_status, snapshot_payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        ) ON CONFLICT (instrument_id, timeframe, bar_time, engine_version, config_hash) DO NOTHING
      `, [
        input.instrumentId,
        input.timeframe,
        snapshot.engineVersion,
        snapshot.configHash,
        snapshot.barIndex,
        snapshot.barTime,
        snapshot.structure.trend,
        snapshot.bias.bias,
        snapshot.bias.dailyTemplate,
        snapshot.bias.dealingRange?.equilibrium ?? null,
        snapshot.liquidity.primaryTarget?.price ?? null,
        snapshot.liquidity.primaryTarget?.kind ?? null,
        snapshot.liquidity.invalidationLevel ?? null,
        snapshot.liquidity.alignmentStatus,
        JSON.stringify(snapshot),
      ]);
    }
  }

  /** Exact historical boundary lookup used by bounded, idempotent research catch-up. */
  async findCompletedAt(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
  }): Promise<StrategyMarketContext | null> {
    const candleResult = await this.database.query<CompletedCandleRow>(`
      SELECT candles.id, candles.instrument_id, candles.timeframe, candles.open_time, candles.close_time,
        candles.open, candles.high, candles.low, candles.close, candles.volume, instruments.tick_size,
        instruments.symbol
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = $1 AND candles.timeframe = $2
        AND candles.is_complete = TRUE AND candles.close_time = $3
        AND candles.close_time <= CURRENT_TIMESTAMP
      ORDER BY candles.open_time DESC
      LIMIT 1
    `, [input.instrumentId, input.timeframe, input.closeTime]);
    const candle = candleResult.rows[0];
    return candle ? this.assembleContext(input, candle) : null;
  }

  /**
   * The most recent completed context whose candle closed at or before `asOf`.
   *
   * The anti-lookahead fetch for higher-timeframe research covariates. At a 1m decision instant the
   * relevant 5m context is the last 5m bar to have *closed*, which `findCompletedAt` (exact
   * close-time match) returns only on a 5m boundary and misses at every 1m bar in between. The
   * `close_time <= $3` guard is the same one `findRegime` uses, so a slower bar that has not closed
   * by the decision instant can never be returned into a faster signal.
   */
  async findCompletedBefore(input: {
    instrumentId: string;
    timeframe: string;
    asOf: Date;
  }): Promise<StrategyMarketContext | null> {
    const candleResult = await this.database.query<CompletedCandleRow>(`
      SELECT candles.id, candles.instrument_id, candles.timeframe, candles.open_time, candles.close_time,
        candles.open, candles.high, candles.low, candles.close, candles.volume, instruments.tick_size,
        instruments.symbol
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = $1 AND candles.timeframe = $2
        AND candles.is_complete = TRUE AND candles.close_time <= $3
      ORDER BY candles.close_time DESC
      LIMIT 1
    `, [input.instrumentId, input.timeframe, input.asOf]);
    const candle = candleResult.rows[0];
    return candle
      ? this.assembleContext({ instrumentId: input.instrumentId, timeframe: input.timeframe }, candle)
      : null;
  }

  async listCompletedContexts(input: { instrumentId: string; timeframe: string; limit: number }): Promise<StrategyMarketContext[]> {
    // A defensive floor: a non-positive limit would otherwise become `LIMIT 0`
    // and silently scan nothing, which reads as "no setups found".
    const limit = Math.max(1, Math.floor(input.limit));
    const candleResult = await this.database.query<CompletedCandleRow>(`
      SELECT
        candles.id,
        candles.instrument_id,
        candles.timeframe,
        candles.open_time,
        candles.close_time,
        candles.open,
        candles.high,
        candles.low,
        candles.close,
        candles.volume,
        instruments.tick_size,
        instruments.symbol
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = $1
        AND candles.timeframe = $2
        AND candles.is_complete = TRUE
        AND candles.close_time <= CURRENT_TIMESTAMP
      ORDER BY candles.close_time DESC, candles.open_time DESC
      LIMIT $3
    `, [input.instrumentId, input.timeframe, limit]);

    // Selected newest-first so LIMIT keeps the most recent window, then reversed
    // to chronological order so callers evaluate bars oldest-to-newest.
    const rows = [...candleResult.rows].reverse();
    return Promise.all(rows.map((candle) => this.assembleContext(input, candle)));
  }

  /** Loads every evidence dimension for one completed candle into a strategy context. */
  private async assembleContext(
    input: { instrumentId: string; timeframe: string },
    candle: CompletedCandleRow,
  ): Promise<StrategyMarketContext> {
    const ictConfigHash = computeIctConfigHash(defaultIctEngineConfig);
    const ictConsumed = ictContextConsumedAt(input.timeframe);
    const [indicators, patterns, priceActionEvents, ictSnapshotRows] = await Promise.all([
      this.database.query<IndicatorSnapshotRow>(`
        SELECT
          indicator_definitions.indicator_code,
          indicator_definitions.algorithm_version,
          indicator_definitions.parameters,
          indicator_snapshots.values
        FROM indicator_snapshots
        INNER JOIN indicator_definitions
          ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
        WHERE indicator_snapshots.candle_id = $1
        ORDER BY
          indicator_definitions.indicator_code ASC,
          indicator_definitions.algorithm_version ASC,
          indicator_definitions.parameters_hash ASC
      `, [candle.id]),
      this.database.query<PatternDetectionRow>(`
        SELECT
          pattern_definitions.pattern_code,
          pattern_definitions.algorithm_version,
          pattern_detections.direction,
          pattern_detections.confidence,
          pattern_detections.context_candle_ids,
          pattern_detections.details
        FROM pattern_detections
        INNER JOIN pattern_definitions
          ON pattern_definitions.id = pattern_detections.pattern_definition_id
        WHERE pattern_detections.candle_id = $1
          -- Point-in-time cutoff = the context candle's close. known_at (the close of the candle the
          -- row is stored on, never moved later by re-detection) is the field that dates when the
          -- evidence was knowable; detected_at is a most-recent-write field that rebuilds bump, so
          -- it is deliberately not used here. Evidence stored on this candle has known_at = close_time.
          AND pattern_detections.known_at <= $2
        ORDER BY pattern_definitions.pattern_code ASC, pattern_definitions.algorithm_version ASC
      `, [candle.id, candle.close_time]),
      this.database.query<PriceActionEventRow>(`
        SELECT event_type, algorithm_version, direction, level, confidence, details
        FROM price_action_events
        WHERE candle_id = $1
          -- known_at, not detected_at: see the pattern_detections query above.
          AND known_at <= $2
        ORDER BY event_type ASC, algorithm_version ASC
      `, [candle.id, candle.close_time]),
      /*
       * Skipped outright at a timeframe no registered strategy reads ICT at -- not queried and then
       * discarded. There is nothing to find there, and the miss would send us on to compute it.
       */
      ictConsumed
        ? this.database.query<{ snapshot_payload: IctStateCompositeSnapshot }>(`
            SELECT snapshot_payload
            FROM ict_state_snapshots
            WHERE instrument_id = $1
              AND timeframe = $2
              AND bar_time = $3
              AND engine_version = $4
              AND config_hash = $5
          `, [input.instrumentId, input.timeframe, candle.open_time, ICT_STATE_ENGINE_VERSION, ictConfigHash])
        : Promise.resolve({ rows: [] as { snapshot_payload: IctStateCompositeSnapshot }[] }),
    ]);

    const regime = await this.findRegime(input, candle) ?? undefined;
    const confluenceSignal = await this.resolveConfluenceSignal(input, candle) ?? undefined;
    const optionChainSignal = await this.resolveOptionChainSignal(input, candle) ?? undefined;

    let ictSnapshot: IctStateCompositeSnapshot | undefined = ictSnapshotRows.rows[0]?.snapshot_payload;
    if (!ictSnapshot && ictConsumed) {
      ictSnapshot = await this.computeAndPersistIctSnapshot(input, candle, ictConfigHash);
    }

    return {
      candle: toCandle(candle),
      indicators: indicators.rows.map((row) => ({
        code: row.indicator_code,
        algorithmVersion: row.algorithm_version,
        parameters: row.parameters,
        values: row.values,
      })),
      patterns: patterns.rows.map((row) => ({
        code: row.pattern_code,
        algorithmVersion: row.algorithm_version,
        direction: row.direction,
        confidence: toNumber(row.confidence, "pattern confidence"),
        contextCandleIds: row.context_candle_ids,
        details: row.details,
      })),
      priceActionEvents: priceActionEvents.rows.map((row) => ({
        eventCode: row.event_type,
        algorithmVersion: row.algorithm_version,
        direction: row.direction,
        level: row.level === null ? null : toNumber(row.level, "price-action level"),
        confidence: toNumber(row.confidence, "price-action confidence"),
        details: row.details,
      })),
      regime,
      ...(confluenceSignal ? { confluenceSignal } : {}),
      ...(optionChainSignal ? { optionChainSignal } : {}),
      ...(ictSnapshot ? { ictSnapshot } : {}),
    };
  }

  /**
   * The expiries listed for `symbol` as of `asOf`, from the newest `option_expiry_calendar`
   * observation at or before `asOf` (point-in-time: a calendar observed later is not visible).
   *
   * Falls back to the distinct expiries of snapshots observed in the preceding day when no
   * calendar observation exists yet (the calendar began ~1.5h after the first snapshots on
   * 2026-08-04), so early history still resolves rather than going silently unavailable.
   */
  private async listExpiryCalendarAsOf(
    symbol: string,
    asOf: Date,
  ): Promise<Array<{ expiryDate: string; expiryKind: string }>> {
    const calendar = await this.database.query<{ expiry_date: string; expiry_kind: string }>(`
      SELECT to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, expiry_kind
      FROM option_expiry_calendar
      WHERE underlying_symbol = $1
        AND observed_at = (
          SELECT MAX(observed_at)
          FROM option_expiry_calendar
          WHERE underlying_symbol = $1 AND observed_at <= $2
        )
    `, [symbol, asOf]);
    if (calendar.rows.length > 0) {
      return calendar.rows.map((row) => ({ expiryDate: row.expiry_date, expiryKind: row.expiry_kind }));
    }
    const fallback = await this.database.query<{ expiry_date: string; expiry_kind: string }>(`
      SELECT DISTINCT to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, expiry_kind
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1
        AND observed_at <= $2
        AND observed_at > $2::timestamptz - INTERVAL '1 day'
    `, [symbol, asOf]);
    return fallback.rows.map((row) => ({ expiryDate: row.expiry_date, expiryKind: row.expiry_kind }));
  }

  /**
   * Windowed put/call OI ratio for the nearest un-settled expiry, as of `candle.close_time`.
   *
   * ## Rule (see `option-chain-signal.ts` for the full statement; mirrored in the two Python scripts)
   *
   * 1. Pick the EXPIRY first from the stored calendar: the earliest expiry whose 15:30 IST
   *    settlement is strictly after the decision time. (The previous join took the latest
   *    `observed_at` first -- which is the farther "tradable roll" book, stored ~0.2s after the
   *    front book -- and its inner `MIN(expiry_date)` then had a single expiry to minimise, so it
   *    was a no-op. It also counted already-settled expiry-day books after 15:30.)
   * 2. Then take the latest snapshot of THAT (symbol, expiry) observed at or before the close,
   *    restricted to 09:15-15:30 IST so a 09:11 pre-open poll (prior-day OI) or a 15:53 post-close
   *    poll can never feed an intraday gate.
   * 3. Unavailable states are explicit (`unavailableReason`), never a silent null.
   *
   * ## What the number is
   *
   * The sums cover the collector's spot-recentred strike WINDOW (`strikecount` per side at
   * collection time), not the whole chain -- hence `pcrWindowed`. `pcr` carries the same value
   * under the old name so stored JSON consumers keep working.
   *
   * Looked up by canonical symbol rather than `instrument_id` (the collector keys snapshots by the
   * lab's symbol). Errors degrade to "no signal" rather than failing the whole context, matching
   * every other optional-evidence resolver on this class.
   */
  private async resolveOptionChainSignal(
    input: { instrumentId: string; timeframe: string },
    candle: CompletedCandleRow,
  ): Promise<OptionChainSignal | undefined> {
    try {
      const instResult = await this.database.query<{ symbol: string }>(
        `SELECT symbol FROM instruments WHERE id = $1`,
        [input.instrumentId],
      );
      const symbol = instResult.rows[0]?.symbol;
      if (!symbol) return undefined;

      const decisionTime = candle.close_time;
      const calendar = await this.listExpiryCalendarAsOf(symbol, decisionTime);
      const expiryDate = selectNearestUnsettledExpiry(calendar.map((entry) => entry.expiryDate), decisionTime);
      if (expiryDate === null) return unavailableOptionChainSignal("NO_UNSETTLED_EXPIRY");

      const latestResult = await this.database.query<{ observed_at: Date }>(`
        SELECT observed_at
        FROM option_chain_snapshots
        WHERE underlying_symbol = $1
          AND expiry_date = $2::date
          AND observed_at <= $3
          AND (observed_at AT TIME ZONE 'Asia/Kolkata')::time BETWEEN TIME '09:15:00' AND TIME '15:30:00'
        ORDER BY observed_at DESC
        LIMIT 1
      `, [symbol, expiryDate, decisionTime]);
      const observedAt = latestResult.rows[0]?.observed_at;
      if (!observedAt) return unavailableOptionChainSignal("NO_SNAPSHOT", { expiryDate });

      const aggResult = await this.database.query<{
        call_oi: string | null;
        put_oi: string | null;
        contracts: string;
        missing_oi: string;
      }>(`
        SELECT
          SUM(CASE WHEN option_type = 'CE' THEN open_interest ELSE 0 END) AS call_oi,
          SUM(CASE WHEN option_type = 'PE' THEN open_interest ELSE 0 END) AS put_oi,
          COUNT(*) AS contracts,
          COUNT(*) FILTER (WHERE open_interest IS NULL) AS missing_oi
        FROM option_chain_snapshots
        WHERE underlying_symbol = $1 AND expiry_date = $2::date AND observed_at = $3
      `, [symbol, expiryDate, observedAt]);
      const row = aggResult.rows[0];

      return buildOptionChainSignal({
        expiryDate,
        observedAt,
        decisionTime,
        callOpenInterest: row?.call_oi != null ? Number(row.call_oi) : 0,
        putOpenInterest: row?.put_oi != null ? Number(row.put_oi) : 0,
        contracts: row?.contracts != null ? Number(row.contracts) : 0,
        contractsWithMissingOpenInterest: row?.missing_oi != null ? Number(row.missing_oi) : 0,
      });
    } catch {
      return undefined;
    }
  }

  private async resolveConfluenceSignal(
    input: { instrumentId: string; timeframe: string },
    candle: CompletedCandleRow,
  ): Promise<StrategyMarketContext["confluenceSignal"]> {
    try {
      const instResult = await this.database.query<{ symbol: string }>(
        `SELECT symbol FROM instruments WHERE id = $1`,
        [input.instrumentId]
      );
      const symbol = instResult.rows[0]?.symbol;
      if (!symbol) return undefined;

      const candResult = await this.database.query<{ pool_type: string; price: string }>(`
        SELECT pool_type, price
        FROM liquidity_pool_candidates
        WHERE symbol = $1
          AND known_at_time <= $2
          AND (invalidated_at_time IS NULL OR invalidated_at_time > $2)
        ORDER BY abs(price::numeric - $3::numeric) ASC
        LIMIT 1
      `, [symbol, candle.close_time, candle.close]);

      const level = candResult.rows[0];
      if (!level) return undefined;

      const levelPrice = Number(level.price);
      const candleClose = Number(candle.close);
      const distanceBps = (Math.abs(candleClose - levelPrice) / levelPrice) * 10000;

      if (distanceBps > 20.0) {
        return {
          is_level_proximate: false,
          nearest_level_type: level.pool_type,
          nearest_level_price: levelPrice,
          distance_bps: distanceBps,
          raw_di: null,
          di_tilde: null,
          directional_bias: "NONE",
          gate_action: "NO_ACTION",
        };
      }

      /*
       * Depth rows are stored under the FRONT-MONTH FUTURES contract's ticker
       * (`NSE:BANKNIFTY26OCTFUT`), never under the index/instrument symbol. The previous lookup used
       * `provider_symbol = symbol.toUpperCase()` ('BANKNIFTY' / 'NIFTY50'), which matches zero rows,
       * so the live order-book gate NEVER saw depth: a missing book became totalBuy=0, raw_di=0, and
       * `raw_di || null` downstream hid it.
       *
       * The contract is resolved the way `collect-depth-frames.ts` resolves what it subscribes to:
       * `frontMonthFuturesSymbol` over the calendar -- here the MONTHLY expiries only, because a
       * futures contract expires with the monthly series, and as of the candle close, not wall-clock
       * now. An instrument with no depth capture (NIFTY50 has none today; its futures ticker matches
       * no stored rows) simply yields no qualifying frame.
       *
       * A frame qualifies only if received within DEPTH_FRAME_MAX_AGE_MS (5s) at or before the close;
       * an older book describes a different bar.
       */
      const calendar = await this.listExpiryCalendarAsOf(symbol, candle.close_time);
      const depthSymbol = frontMonthFuturesSymbol({
        underlying: futuresTickerUnderlying(symbol),
        now: candle.close_time,
        expiries: calendar.filter((entry) => entry.expiryKind === "MONTHLY").map((entry) => entry.expiryDate),
      });

      const depthResult: { rows: DepthFrameRow[] } = depthSymbol === null
        ? { rows: [] }
        : await this.database.query<DepthFrameRow>(`
          SELECT received_at, bid_price, bid_qty, ask_price, ask_qty, total_buy_qty, total_sell_qty
          FROM depth_frames
          WHERE provider_symbol = $1 AND received_at <= $2 AND received_at >= $3
          ORDER BY received_at DESC, sequence_no DESC
          LIMIT 1
        `, [depthSymbol, candle.close_time, new Date(candle.close_time.getTime() - DEPTH_FRAME_MAX_AGE_MS)]);

      const df = depthResult.rows[0];
      if (!df || depthSymbol === null) {
        // Explicit "no depth" state. raw_di/di_tilde are null -- NOT 0 -- so no gate can read an
        // absent book as a perfectly balanced one. `depth_state` is extra to the declared context
        // type on purpose: it rides along in the captured rawContext for diagnosis.
        const noDepthSignal: ConfluenceSignal = {
          is_level_proximate: true,
          nearest_level_type: level.pool_type,
          nearest_level_price: levelPrice,
          distance_bps: distanceBps,
          raw_di: null,
          di_tilde: null,
          di_status: "UNAVAILABLE_DEPTH",
          directional_bias: "NONE",
          gate_action: "NO_ACTION",
          depth_state: "NO_DEPTH",
          depth_symbol: depthSymbol,
          depth_max_age_ms: DEPTH_FRAME_MAX_AGE_MS,
        };
        return noDepthSignal;
      }

      const depthData = {
        bidPrice: df.bid_price.map(Number),
        bidQty: df.bid_qty.map(Number),
        askPrice: df.ask_price.map(Number),
        askQty: df.ask_qty.map(Number),
        // A missing total stays null (-> raw DI unavailable); it is never coerced to 0, which would
        // read as a one-sided book.
        totalBuyQty: df.total_buy_qty === null || df.total_buy_qty === undefined ? null : Number(df.total_buy_qty),
        totalSellQty: df.total_sell_qty === null || df.total_sell_qty === undefined ? null : Number(df.total_sell_qty),
      };

      // Causal di_tilde: the prior-minute DI history of the SAME contract and the SAME IST session,
      // strictly before the minute of the frame being standardised (so before the decision time and
      // never using a later frame). Without it di_tilde stays null: see `causalStandardiseDi`.
      const frameTime = df.received_at instanceof Date ? df.received_at : candle.close_time;
      const priorMinuteDi = await this.loadPriorMinuteDi(depthSymbol, frameTime);

      return resolveConfluenceSignalFromDepth({
        nearestLevelType: level.pool_type,
        nearestLevelPrice: levelPrice,
        distanceBps,
        depth: depthData,
        priorMinuteDi,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * The causal DI history behind `di_tilde`: the LAST raw DI of each complete minute of the trailing
   * `DI_STANDARDISATION_WINDOW_MINUTES`, for `depthSymbol`, within the same IST session as `asOf`,
   * strictly before the minute containing `asOf` (the minute rule lives in
   * `trailingSessionMinuteDiSamples`). `asOf` is the received time of the frame being standardised,
   * which is itself at or before the decision cutoff, so no frame after the decision is ever read.
   *
   * Frames without usable totals are filtered in SQL (missing is missing, never DI = 0) BEFORE the
   * per-minute pick, so a bad last frame does not hide an earlier good one in the same minute.
   * The result may be shorter than the minimum history; `causalStandardiseDi` then yields null.
   */
  private async loadPriorMinuteDi(depthSymbol: string, asOf: Date): Promise<number[]> {
    const minuteMs = 60_000;
    const currentMinuteStart = new Date(Math.floor(asOf.getTime() / minuteMs) * minuteMs);
    const windowStart = new Date(currentMinuteStart.getTime() - DI_STANDARDISATION_WINDOW_MINUTES * minuteMs);
    const sessionStart = istSessionStart(asOf);
    const from = windowStart.getTime() > sessionStart.getTime() ? windowStart : sessionStart;

    const result = await this.database.query<PriorDepthTotalsRow>(`
      SELECT DISTINCT ON (date_trunc('minute', received_at))
        received_at, total_buy_qty, total_sell_qty
      FROM depth_frames
      WHERE provider_symbol = $1
        AND received_at >= $2
        AND received_at < $3
        AND total_buy_qty IS NOT NULL
        AND total_sell_qty IS NOT NULL
        AND total_buy_qty + total_sell_qty > 0
      ORDER BY date_trunc('minute', received_at) ASC, received_at DESC, sequence_no DESC
    `, [depthSymbol, from, currentMinuteStart]);

    const frames = result.rows
      .filter((row) => row.received_at instanceof Date)
      .map((row) => ({
        receivedAt: row.received_at,
        rawDi: calculateDecayingDepthImbalance({
          totalBuyQty: row.total_buy_qty === null ? null : Number(row.total_buy_qty),
          totalSellQty: row.total_sell_qty === null ? null : Number(row.total_sell_qty),
        }).rawDi,
      }));
    return trailingSessionMinuteDiSamples(frames, asOf);
  }

  /**
   * Resolves the volatility regime, or null when it cannot be measured. An absent
   * regime is not an absent candle: the target instrument's evidence is still valid
   * research evidence, so a gap in the VIX series must degrade this one field rather
   * than discard the context and report it as a missing candle.
   */
  private async findRegime(
    input: { instrumentId: string; timeframe: string },
    candle: CompletedCandleRow,
  ): Promise<RegimeContext | null> {
    const raw = await this.findRawVix({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      closeTime: candle.close_time,
    });
    return raw ? deriveVolatilityRegime(raw.vixClose, raw.vixSma20) : null;
  }

  /**
   * The raw VIX close and its SMA(20), the same point-in-time lookup `findRegime` uses -- but
   * returning the pair itself rather than folding it into `deriveVolatilityRegime`'s ratio.
   *
   * Public (unlike `findRegime`) because Brain V2.2's State Interpreter (`state-interpreter.ts`)
   * threads `volatilityReading: {vixClose, vixSma20} | null` as a caller-supplied sibling input and
   * derives its own regime reading itself -- it does not consume `RegimeContext`. Extracted as a
   * shared private helper rather than duplicating the query, so this and `findRegime` cannot silently
   * drift onto two different VIX readings for the same instant.
   */
  async findRawVolatilityReading(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
  }): Promise<{ vixClose: number; vixSma20: number } | null> {
    return this.findRawVix(input);
  }

  private async findRawVix(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
  }): Promise<{ vixClose: number; vixSma20: number } | null> {
    const vixResult = await this.database.query<{ id: string }>(
      "SELECT id FROM instruments WHERE symbol = $1",
      [regimeSourceInstrumentSymbol],
    );
    const vixInstrumentId = vixResult.rows[0]?.id;
    if (!vixInstrumentId || vixInstrumentId === input.instrumentId) {
      return null;
    }

    const stalenessMilliseconds = regimeStalenessMilliseconds(input.timeframe);
    if (stalenessMilliseconds === null) {
      return null;
    }

    // The VIX bar must have closed no later than the target bar, so the regime is
    // knowable at decision time. The lower bound stops a long gap in the VIX series
    // from carrying a stale reading forward as if it were current.
    const earliestAcceptableCloseTime = new Date(input.closeTime.getTime() - stalenessMilliseconds);
    const vixCandleResult = await this.database.query<{ id: string; close: string }>(`
      SELECT id, close
      FROM candles
      WHERE instrument_id = $1
        AND timeframe = $2
        AND is_complete = TRUE
        AND close_time <= $3
        AND close_time >= $4
      ORDER BY close_time DESC
      LIMIT 1
    `, [vixInstrumentId, input.timeframe, input.closeTime, earliestAcceptableCloseTime]);
    const vixCandle = vixCandleResult.rows[0];
    if (!vixCandle) {
      return null;
    }

    const vixSmaResult = await this.database.query<{ values: IndicatorValues }>(`
      SELECT indicator_snapshots.values
      FROM indicator_snapshots
      INNER JOIN indicator_definitions
        ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
      WHERE indicator_snapshots.candle_id = $1
        AND indicator_definitions.indicator_code = $2
        AND indicator_definitions.algorithm_version = $3
        AND indicator_definitions.parameters->>'period' = $4
      ORDER BY indicator_definitions.parameters_hash ASC
      LIMIT 1
    `, [
      vixCandle.id,
      regimeSourceIndicatorCode,
      regimeSourceIndicatorAlgorithmVersion,
      String(regimeSourceIndicatorPeriod),
    ]);
    const vixSma20 = Number(vixSmaResult.rows[0]?.values.value);
    if (!Number.isFinite(vixSma20)) {
      return null;
    }

    return { vixClose: toNumber(vixCandle.close, "VIX close"), vixSma20 };
  }
}
