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
    const [indicators, patterns, priceActionEvents] = await Promise.all([
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
    ]);

    const regime = await this.findRegime(input, candle) ?? undefined;

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
