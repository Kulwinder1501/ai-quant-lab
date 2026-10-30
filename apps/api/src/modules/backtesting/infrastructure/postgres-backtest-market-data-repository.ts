import { ictGapGuardFor } from "../../technical-analysis/domain/ict/series-gaps.js";
import { experimentalPriceActionAlgorithmVersions, experimentalPriceActionVersionsSql } from "../../pattern-recognition/domain/market-pattern.js";
import type { QueryResultRow } from "pg";
import type { CandlestickPatternCode, PatternDirection, PriceActionEventCode } from "../../pattern-recognition/domain/market-pattern.js";
import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { BacktestMarketDataRepository } from "../domain/backtesting.js";
import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import { IctCompositeEngine } from "../../technical-analysis/domain/ict/composite-engine.js";
import { ICT_STATE_ENGINE_VERSION, computeIctConfigHash, defaultIctEngineConfig, type IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import { computeIctSnapshotsForContexts } from "../../technical-analysis/domain/ict/replay-builder.js";


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
  symbol?: string;
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
  /**
   * `includeExperimentalPriceActionVersions` lets one run read an experimental price-action version (price-action-v4) that every
   * other reader is kept away from, so a strategy pinned to it by `--strategy-config` can be replayed against the current version.
   * The default and the ordinary query are unchanged; the version arrives through a separate query, and only labels in the
   * experimental list are accepted, so this cannot be used to read an arbitrary or superseded version.
   */
  constructor(
    private readonly database: DatabaseQueryable,
    private readonly includeExperimentalPriceActionVersions: readonly string[] = [],
  ) {
    for (const version of includeExperimentalPriceActionVersions) {
      if (!experimentalPriceActionAlgorithmVersions.includes(version)) {
        throw new Error(`"${version}" is not an experimental price-action version; the ordinary loader already reads it or it is not readable here.`);
      }
    }
  }

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
        instruments.tick_size,
        instruments.symbol
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
    // The same identity the live path writes under: gold's snapshots come from an engine with a data-gap guard.
    const ictConfigHash = computeIctConfigHash(defaultIctEngineConfig, ictGapGuardFor(candleResult.rows[0]?.symbol, input.timeframe));
    const [indicatorResult, patternResult, priceActionResult, ictSnapshotResult] = await Promise.all([
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
          -- Point-in-time on known_at (candle close), NOT detected_at. detected_at is a most-recent-write
          -- field that rebuilds bump past the cutoff; requiring detected_at <= cutoff as well would
          -- silently erase history from every replay. known_at never moves later.
          AND pattern_detections.known_at <= $2
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
          -- known_at, not detected_at: see the pattern_detections query above.
          AND known_at <= $2
          -- Experimental versions (price-action-v4) are written beside the current one for comparison only; a replay must not see them.
          AND algorithm_version NOT IN (${experimentalPriceActionVersionsSql()})
        ORDER BY candle_id ASC, event_type ASC, algorithm_version ASC
      `, [candleIds, input.dataCutoffAt]),
      this.database.query<{ bar_time: Date; snapshot_payload: IctStateCompositeSnapshot }>(`
        SELECT bar_time, snapshot_payload
        FROM ict_state_snapshots
        WHERE instrument_id = $1
          AND timeframe = $2
          AND bar_time >= $3
          AND bar_time <= $4
          AND engine_version = $5
          AND config_hash = $6
      `, [input.instrumentId, input.timeframe, input.dataWindowStart, input.dataWindowEnd, ICT_STATE_ENGINE_VERSION, ictConfigHash]),
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

    const requestedExperimentalRows = this.includeExperimentalPriceActionVersions.length === 0
      ? []
      : (await this.database.query<PriceActionEventRow>(`
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
          AND known_at <= $2
          AND algorithm_version = ANY($3::text[])
        ORDER BY candle_id ASC, event_type ASC, algorithm_version ASC
      `, [candleIds, input.dataCutoffAt, [...this.includeExperimentalPriceActionVersions]])).rows;

    const priceActionEventsByCandle = new Map<string, StrategyMarketContext["priceActionEvents"]>();
    for (const row of [...priceActionResult.rows, ...requestedExperimentalRows]) {
      appendToMap(priceActionEventsByCandle, row.candle_id, {
        eventCode: row.event_type,
        algorithmVersion: row.algorithm_version,
        direction: row.direction,
        level: row.level === null ? null : toNumber(row.level, "price-action level"),
        confidence: toNumber(row.confidence, "price-action confidence"),
        details: row.details,
      });
    }


    const ictSnapshotsByTime = new Map<number, IctStateCompositeSnapshot>();
    for (const row of ictSnapshotResult.rows) {
      ictSnapshotsByTime.set(row.bar_time.getTime(), row.snapshot_payload);
    }

    const missingCandles = candleResult.rows.filter(r => !ictSnapshotsByTime.has(r.open_time.getTime()));
    if (missingCandles.length > 0) {
      const firstMissingTime = missingCandles[0].open_time;
      const historyResult = await this.database.query<CompletedCandleRow>(`
        (
          SELECT
            id, instrument_id, timeframe, open_time, close_time,
            open, high, low, close, volume, '0' as tick_size
          FROM candles
          WHERE instrument_id = $1
            AND timeframe = $2
            AND is_complete = TRUE
            AND open_time < $3
          ORDER BY open_time DESC
          LIMIT 1000
        )
        UNION ALL
        (
          SELECT
            id, instrument_id, timeframe, open_time, close_time,
            open, high, low, close, volume, '0' as tick_size
          FROM candles
          WHERE instrument_id = $1
            AND timeframe = $2
            AND is_complete = TRUE
            AND open_time >= $3
            AND open_time <= $4
          ORDER BY open_time ASC
        )
        ORDER BY open_time ASC
      `, [input.instrumentId, input.timeframe, firstMissingTime, input.dataWindowEnd]);

const mockContexts = historyResult.rows.map(r => ({
        candle: {
          id: r.id,
          instrumentId: r.instrument_id,
          timeframe: r.timeframe,
          openTime: r.open_time,
          closeTime: r.close_time,
          open: toNumber(r.open, "open"),
          high: toNumber(r.high, "high"),
          low: toNumber(r.low, "low"),
          close: toNumber(r.close, "close"),
          volume: toNumber(r.volume, "volume"),
          tickSize: 0
        },
        indicators: [],
        patterns: [],
        priceActionEvents: []
      } as unknown as StrategyMarketContext));

      // Compute snapshots natively using replay builder to get HTF bias
      // 3 bars of 5m = 15m HTF bias
      // The higher timeframe is the daily session, chosen by the builder. This used to pass 3
      // bars for a 5m base -- a 15m bucket -- which disagreed with the builder's own 60m default
      // and with the doctrine's daily anchor.
      const snapshots = computeIctSnapshotsForContexts(mockContexts);

      for (let i = 0; i < mockContexts.length; i++) {
        const snapshot = snapshots[i];
        const openTimeMs = mockContexts[i].candle.openTime.getTime();
        if (openTimeMs >= firstMissingTime.getTime() && !ictSnapshotsByTime.has(openTimeMs) && mockContexts[i].candle.openTime <= input.dataWindowEnd) {
          ictSnapshotsByTime.set(openTimeMs, snapshot);
          
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
    }

    return candleResult.rows.map((row) => {
      const ictSnapshot = ictSnapshotsByTime.get(row.open_time.getTime());
      return {
        candle: toCandle(row),
        indicators: indicatorsByCandle.get(row.id) ?? [],
        patterns: patternsByCandle.get(row.id) ?? [],
        priceActionEvents: priceActionEventsByCandle.get(row.id) ?? [],
        ...(ictSnapshot ? { ictSnapshot } : {}),
      };
    });
  }
}
