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
import { ICT_STATE_ENGINE_VERSION, computeIctConfigHash, defaultIctEngineConfig, type IctStateCompositeSnapshot } from "../../../modules/technical-analysis/domain/ict/config.js";


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
        instruments.tick_size
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
    const historyResult = await this.database.query<CompletedCandleRow>(`
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
        instruments.tick_size
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = $1
        AND candles.timeframe = $2
        AND candles.is_complete = TRUE
        AND candles.open_time <= $3
      ORDER BY candles.open_time DESC
      LIMIT 1000
    `, [input.instrumentId, input.timeframe, targetCandle.open_time]);

    if (historyResult.rows.length === 0) return undefined;

    const rows = [...historyResult.rows].reverse();
    const causalCandles = rows.map((r) => ({
      id: r.id,
      openTime: r.open_time,
      open: toNumber(r.open, "open"),
      high: toNumber(r.high, "high"),
      low: toNumber(r.low, "low"),
      close: toNumber(r.close, "close"),
      volume: toNumber(r.volume, "volume"),
    }));

    const engine = new IctCompositeEngine(defaultIctEngineConfig);
    let snapshot: IctStateCompositeSnapshot | undefined;

    for (let i = 0; i < causalCandles.length; i++) {
      snapshot = engine.processCandle(causalCandles, i);
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
        candles.open, candles.high, candles.low, candles.close, candles.volume, instruments.tick_size
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
        candles.open, candles.high, candles.low, candles.close, candles.volume, instruments.tick_size
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
        instruments.tick_size
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
      ...(ictSnapshot ? { ictSnapshot } : {}),
    };
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
    const earliestAcceptableCloseTime = new Date(candle.close_time.getTime() - stalenessMilliseconds);
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
    `, [vixInstrumentId, input.timeframe, candle.close_time, earliestAcceptableCloseTime]);
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

    return deriveVolatilityRegime(toNumber(vixCandle.close, "VIX close"), vixSma20);
  }
}
