import type { QueryResultRow } from "pg";
import type { CandlestickPatternCode, PatternDirection, PriceActionEventCode } from "../../pattern-recognition/domain/market-pattern.js";
import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { BacktestMarketDataRepository } from "../domain/backtesting.js";
import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";

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
  candle_id: string;
  indicator_code: IndicatorCode;
  algorithm_version: string;
  parameters: Record<string, unknown>;
  values: IndicatorValues;
}

interface PatternDetectionRow extends QueryResultRow {
  candle_id: string;
  pattern_code: CandlestickPatternCode;
  algorithm_version: string;
  direction: PatternDirection;
  confidence: string;
  context_candle_ids: string[];
  details: Record<string, unknown>;
}

interface PriceActionEventRow extends QueryResultRow {
  candle_id: string;
  event_type: PriceActionEventCode;
  algorithm_version: string;
  direction: PatternDirection;
  level: string | null;
  confidence: string;
  details: Record<string, unknown>;
}

function toNumber(value: string | number, field: string): number {
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

function appendToMap<T>(target: Map<string, T[]>, candleId: string, value: T): void {
  const existing = target.get(candleId);
  if (existing) {
    existing.push(value);
    return;
  }
  target.set(candleId, [value]);
}

/**
 * Reconstructs the evidence attached to each completed candle. The data
 * cutoff is a stored-evidence revision boundary: it constrains when rows were
 * received/calculated/detected, while the caller controls the historical
 * source-time window separately.
 */
export class PostgresBacktestMarketDataRepository implements BacktestMarketDataRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listContexts(input: {
    instrumentId: string;
    timeframe: string;
    dataWindowStart: Date;
    dataWindowEnd: Date;
    dataCutoffAt: Date;
  }): Promise<StrategyMarketContext[]> {
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
        AND candles.open_time >= $3
        AND candles.close_time <= $4
        AND candles.received_at <= $5
      ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
    `, [
      input.instrumentId,
      input.timeframe,
      input.dataWindowStart,
      input.dataWindowEnd,
      input.dataCutoffAt,
    ]);

    if (candleResult.rows.length === 0) {
      return [];
    }

    const candleIds = candleResult.rows.map((row) => row.id);
    const [indicatorResult, patternResult, priceActionResult] = await Promise.all([
      this.database.query<IndicatorSnapshotRow>(`
        SELECT
          indicator_snapshots.candle_id,
          indicator_definitions.indicator_code,
          indicator_definitions.algorithm_version,
          indicator_definitions.parameters,
          indicator_snapshots.values
        FROM indicator_snapshots
        INNER JOIN indicator_definitions
          ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
        WHERE indicator_snapshots.candle_id = ANY($1::uuid[])
          AND indicator_snapshots.calculated_at <= $2
        ORDER BY
          indicator_snapshots.candle_id ASC,
          indicator_definitions.indicator_code ASC,
          indicator_definitions.algorithm_version ASC,
          indicator_definitions.parameters_hash ASC
      `, [candleIds, input.dataCutoffAt]),
      this.database.query<PatternDetectionRow>(`
        SELECT
          pattern_detections.candle_id,
          pattern_definitions.pattern_code,
          pattern_definitions.algorithm_version,
          pattern_detections.direction,
          pattern_detections.confidence,
          pattern_detections.context_candle_ids,
          pattern_detections.details
        FROM pattern_detections
        INNER JOIN pattern_definitions
          ON pattern_definitions.id = pattern_detections.pattern_definition_id
        WHERE pattern_detections.candle_id = ANY($1::uuid[])
          AND pattern_detections.detected_at <= $2
        ORDER BY
          pattern_detections.candle_id ASC,
          pattern_definitions.pattern_code ASC,
          pattern_definitions.algorithm_version ASC
      `, [candleIds, input.dataCutoffAt]),
      this.database.query<PriceActionEventRow>(`
        SELECT
          candle_id,
          event_type,
          algorithm_version,
          direction,
          level,
          confidence,
          details
        FROM price_action_events
        WHERE candle_id = ANY($1::uuid[])
          AND detected_at <= $2
        ORDER BY candle_id ASC, event_type ASC, algorithm_version ASC
      `, [candleIds, input.dataCutoffAt]),
    ]);

    const indicatorsByCandle = new Map<string, StrategyMarketContext["indicators"]>();
    for (const row of indicatorResult.rows) {
      appendToMap(indicatorsByCandle, row.candle_id, {
        code: row.indicator_code,
        algorithmVersion: row.algorithm_version,
        parameters: row.parameters,
        values: row.values,
      });
    }

    const patternsByCandle = new Map<string, StrategyMarketContext["patterns"]>();
    for (const row of patternResult.rows) {
      appendToMap(patternsByCandle, row.candle_id, {
        code: row.pattern_code,
        algorithmVersion: row.algorithm_version,
        direction: row.direction,
        confidence: toNumber(row.confidence, "pattern confidence"),
        contextCandleIds: row.context_candle_ids,
        details: row.details,
      });
    }

    const priceActionEventsByCandle = new Map<string, StrategyMarketContext["priceActionEvents"]>();
    for (const row of priceActionResult.rows) {
      appendToMap(priceActionEventsByCandle, row.candle_id, {
        eventCode: row.event_type,
        algorithmVersion: row.algorithm_version,
        direction: row.direction,
        level: row.level === null ? null : toNumber(row.level, "price-action level"),
        confidence: toNumber(row.confidence, "price-action confidence"),
        details: row.details,
      });
    }

    return candleResult.rows.map((row) => ({
      candle: toCandle(row),
      indicators: indicatorsByCandle.get(row.id) ?? [],
      patterns: patternsByCandle.get(row.id) ?? [],
      priceActionEvents: priceActionEventsByCandle.get(row.id) ?? [],
    }));
  }
}
