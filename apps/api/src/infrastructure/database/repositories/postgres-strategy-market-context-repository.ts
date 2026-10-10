import type { QueryResultRow } from "pg";
import type { IndicatorCode, IndicatorValues } from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type {
  CandlestickPatternCode,
  PatternDirection,
  PriceActionEventCode,
} from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type {
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
import { resolveConfluenceSignalFromDepth } from "../../../modules/strategy-engine/domain/orderbook-directional-gate.js";


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

/**
 * How stale the most recent option-chain snapshot may be and still count as "known at decision
 * time" for `optionChainSignal`. Matches `apps/ml/oi_pcr_signal_check.py`'s
 * MAXIMUM_SNAPSHOT_AGE_MINUTES -- same collector, same ~7-8 minute polling cadence, no reason to
 * invent a different tolerance for the live path than the one already validated offline.
 */
const OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES = 15;

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
        ORDER BY pattern_definitions.pattern_code ASC, pattern_definitions.algorithm_version ASC
      `, [candle.id]),
      this.database.query<PriceActionEventRow>(`
        SELECT event_type, algorithm_version, direction, level, confidence, details
        FROM price_action_events
        WHERE candle_id = $1
        ORDER BY event_type ASC, algorithm_version ASC
      `, [candle.id]),
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
   * Whole-chain PCR (put OI / call OI, nearest un-expired expiry) as of `candle.close_time`.
   *
   * Reuses the same as-of join pattern as `resolveConfluenceSignal` below: resolve the
   * instrument's canonical symbol, then look up the option-chain side by symbol rather than
   * `instrument_id` (the chain collector keys snapshots by the lab's canonical symbol, not the
   * instruments table's UUID). Errors degrade to "no signal" rather than failing the whole
   * context, matching every other optional-evidence resolver on this class.
   */
  private async resolveOptionChainSignal(
    input: { instrumentId: string; timeframe: string },
    candle: CompletedCandleRow,
  ): Promise<StrategyMarketContext["optionChainSignal"]> {
    try {
      const instResult = await this.database.query<{ symbol: string }>(
        `SELECT symbol FROM instruments WHERE id = $1`,
        [input.instrumentId],
      );
      const symbol = instResult.rows[0]?.symbol;
      if (!symbol) return undefined;

      const latestResult = await this.database.query<{ observed_at: Date }>(`
        SELECT observed_at
        FROM option_chain_snapshots
        WHERE underlying_symbol = $1 AND observed_at <= $2
        ORDER BY observed_at DESC
        LIMIT 1
      `, [symbol, candle.close_time]);
      const observedAt = latestResult.rows[0]?.observed_at;
      if (!observedAt) {
        return { pcr: null, callOpenInterest: null, putOpenInterest: null, observedAt: null, ageMinutes: null };
      }

      const ageMinutes = (candle.close_time.getTime() - observedAt.getTime()) / 60_000;
      if (ageMinutes > OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES) {
        return { pcr: null, callOpenInterest: null, putOpenInterest: null, observedAt: null, ageMinutes: null };
      }

      // Nearest un-expired expiry at that snapshot, same aggregate definition
      // `apps/ml/oi_pcr_signal_check.py` and `run_hybrid_confluence_backtest.py` use, so the live
      // gate and the offline research checks can't silently drift onto two different PCR
      // definitions.
      const aggResult = await this.database.query<{ call_oi: string | null; put_oi: string | null }>(`
        WITH nearest_expiry AS (
          SELECT MIN(expiry_date) AS expiry_date
          FROM option_chain_snapshots
          WHERE underlying_symbol = $1 AND observed_at = $2 AND expiry_date >= observed_at::date
        )
        SELECT
          SUM(CASE WHEN s.option_type = 'CE' THEN s.open_interest ELSE 0 END) AS call_oi,
          SUM(CASE WHEN s.option_type = 'PE' THEN s.open_interest ELSE 0 END) AS put_oi
        FROM option_chain_snapshots s, nearest_expiry ne
        WHERE s.underlying_symbol = $1 AND s.observed_at = $2 AND s.expiry_date = ne.expiry_date
      `, [symbol, observedAt]);

      const callOi = aggResult.rows[0]?.call_oi != null ? Number(aggResult.rows[0].call_oi) : 0;
      const putOi = aggResult.rows[0]?.put_oi != null ? Number(aggResult.rows[0].put_oi) : 0;
      const pcr = callOi > 0 ? putOi / callOi : null;

      return { pcr, callOpenInterest: callOi, putOpenInterest: putOi, observedAt, ageMinutes };
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

      const depthResult = await this.database.query<{
        bid_price: string[];
        bid_qty: string[];
        ask_price: string[];
        ask_qty: string[];
        total_buy_qty: string;
        total_sell_qty: string;
      }>(`
        SELECT bid_price, bid_qty, ask_price, ask_qty, total_buy_qty, total_sell_qty
        FROM depth_frames
        WHERE provider_symbol = $1 AND received_at <= $2
        ORDER BY received_at DESC, sequence_no DESC
        LIMIT 1
      `, [symbol.toUpperCase(), candle.close_time]);

      const df = depthResult.rows[0];
      const depthData = {
        bidPrice: df?.bid_price ? df.bid_price.map(Number) : [],
        bidQty: df?.bid_qty ? df.bid_qty.map(Number) : [],
        askPrice: df?.ask_price ? df.ask_price.map(Number) : [],
        askQty: df?.ask_qty ? df.ask_qty.map(Number) : [],
        totalBuyQty: df?.total_buy_qty ? Number(df.total_buy_qty) : 0,
        totalSellQty: df?.total_sell_qty ? Number(df.total_sell_qty) : 0,
      };

      return resolveConfluenceSignalFromDepth({
        nearestLevelType: level.pool_type,
        nearestLevelPrice: levelPrice,
        distanceBps,
        depth: depthData,
      });
    } catch {
      return undefined;
    }
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
