import type { QueryResultRow } from "pg";
import type { InstrumentType } from "../../../modules/market-data/domain/instrument.js";
import type { ModelPredictionLabel, ModelStage } from "../../../modules/model-predictions/domain/model-prediction.js";
import type {
  CandlestickPatternCode,
  PatternDirection,
  PriceActionEventCode,
} from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { IndicatorCode, IndicatorValues } from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type {
  ActiveResearchStrategy,
  ListMarketScannerInput,
  ListWatchlistInput,
  MarketScannerQueryRepository,
  MarketScannerRow as MarketScannerProjectionRow,
  ScannerCompletedCandle,
  ScannerIndicator,
  ScannerModelPrediction,
  ScannerPattern,
  ScannerPriceActionEvent,
  ScannerExchange,
  WatchlistInstrument,
} from "../../../modules/market-scanner/domain/market-scanner.js";
import { scannerExchanges } from "../../../modules/market-scanner/domain/market-scanner.js";
import type { DatabaseQueryable } from "../database.js";

interface WatchlistRow extends QueryResultRow {
  instrument_id: string;
  instrument_exchange: string;
  instrument_symbol: string;
  instrument_display_name: string;
  instrument_type: string;
  instrument_currency: string;
  instrument_timezone: string;
  instrument_tick_size: string | number;
  instrument_lot_size: string | number;
}

interface MarketScannerDatabaseRow extends QueryResultRow {
  instrument_id: string;
  instrument_exchange: string;
  instrument_symbol: string;
  instrument_display_name: string;
  instrument_type: string;
  candle_id: string;
  candle_timeframe: string;
  candle_open_time: Date | string;
  candle_close_time: Date | string;
  candle_open: string | number;
  candle_high: string | number;
  candle_low: string | number;
  candle_close: string | number;
  candle_volume: string | number;
  indicators: unknown;
  patterns: unknown;
  price_action_events: unknown;
  prediction_id: string | null;
  prediction_label: ModelPredictionLabel | null;
  prediction_confidence: string | number | null;
  prediction_created_at: Date | string | null;
  prediction_evidence_cutoff_at: Date | string | null;
  model_key: string | null;
  model_version: string | number | null;
  model_algorithm: string | null;
  model_current_stage: ModelStage | null;
}

interface ActiveResearchStrategyRow extends QueryResultRow {
  strategy_key: string;
  strategy_name: string;
  strategy_version: string | number;
}

const knownInstrumentTypes = ["INDEX", "EQUITY", "ETF", "OPTION", "FUTURE"] as const;
const knownIndicatorCodes = [
  "SMA",
  "EMA",
  "RSI",
  "MACD",
  "ATR",
  "VWAP",
  "BOLLINGER_BANDS",
  "SUPERTREND",
  "FVG",
  "BOS",
  "CHOCH",
  "LIQUIDITY_SWEEP",
  "ORDER_BLOCK",
  "EQUILIBRIUM_ZONE",
] as const;
const knownPatternCodes = [
  "DOJI",
  "HAMMER",
  "HANGING_MAN",
  "SHOOTING_STAR",
  "BULLISH_ENGULFING",
  "BEARISH_ENGULFING",
  "MORNING_STAR",
  "EVENING_STAR",
  "BULLISH_HARAMI",
  "BEARISH_HARAMI",
  "THREE_WHITE_SOLDIERS",
  "THREE_BLACK_CROWS",
  "INSIDE_BAR",
  "OUTSIDE_BAR",
] as const;
const knownPriceActionEventCodes = [
  "BREAKOUT",
  "BREAKDOWN",
  "SUPPORT",
  "RESISTANCE",
  "UPTREND",
  "DOWNTREND",
  "RANGE",
  "PULLBACK",
  "SWING_HIGH",
  "SWING_LOW",
] as const;
const knownDirections = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
const knownModelStages = ["CANDIDATE", "PRODUCTION", "REJECTED", "ARCHIVED"] as const;

function asFiniteNumber(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asPositiveNumber(value: string | number, field: string): number {
  const parsed = asFiniteNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asNonNegativeNumber(value: string | number, field: string): number {
  const parsed = asFiniteNumber(value, field);
  if (parsed < 0) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asPositiveInteger(value: string | number, field: string): number {
  const parsed = asPositiveNumber(value, field);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asConfidence(value: string | number, field: string): number {
  const parsed = asFiniteNumber(value, field);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asUnknownConfidence(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return asConfidence(value, field);
}

function asDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asNonBlankText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value;
}

function asScannerExchange(value: string): ScannerExchange {
  if (!scannerExchanges.includes(value as ScannerExchange)) {
    throw new Error("Database returned an invalid instrument exchange.");
  }
  return value as ScannerExchange;
}

function asInstrumentType(value: string): InstrumentType {
  if (!(knownInstrumentTypes as readonly string[]).includes(value)) {
    throw new Error("Database returned an invalid instrument type.");
  }
  return value as InstrumentType;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value;
}

function asIndicatorParameters(value: unknown): Record<string, string | number | boolean> {
  const record = asRecord(value, "indicator parameters");
  for (const parameterValue of Object.values(record)) {
    if (
      (typeof parameterValue !== "string" && typeof parameterValue !== "number" && typeof parameterValue !== "boolean")
      || (typeof parameterValue === "number" && !Number.isFinite(parameterValue))
    ) {
      throw new Error("Database returned an invalid indicator parameters.");
    }
  }
  return record as Record<string, string | number | boolean>;
}

function asIndicatorValues(value: unknown): IndicatorValues {
  const record = asRecord(value, "indicator values");
  for (const indicatorValue of Object.values(record)) {
    if (
      indicatorValue !== null
      && typeof indicatorValue !== "string"
      && typeof indicatorValue !== "number"
    ) {
      throw new Error("Database returned an invalid indicator values.");
    }
    if (typeof indicatorValue === "number" && !Number.isFinite(indicatorValue)) {
      throw new Error("Database returned an invalid indicator values.");
    }
  }
  return record as IndicatorValues;
}

function asIndicatorCode(value: unknown): IndicatorCode {
  if (!knownIndicatorCodes.includes(value as IndicatorCode)) {
    throw new Error("Database returned an invalid indicator code.");
  }
  return value as IndicatorCode;
}

function asPatternCode(value: unknown): CandlestickPatternCode {
  if (!knownPatternCodes.includes(value as CandlestickPatternCode)) {
    throw new Error("Database returned an invalid pattern code.");
  }
  return value as CandlestickPatternCode;
}

function asPriceActionEventCode(value: unknown): PriceActionEventCode {
  if (!knownPriceActionEventCodes.includes(value as PriceActionEventCode)) {
    throw new Error("Database returned an invalid price-action event type.");
  }
  return value as PriceActionEventCode;
}

function asDirection(value: unknown, field: string): PatternDirection {
  if (!knownDirections.includes(value as PatternDirection)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return value as PatternDirection;
}

function asPredictionLabel(value: unknown): ModelPredictionLabel {
  if (!knownDirections.includes(value as ModelPredictionLabel)) {
    throw new Error("Database returned an invalid prediction label.");
  }
  return value as ModelPredictionLabel;
}

function asModelStage(value: unknown): ModelStage {
  if (!knownModelStages.includes(value as ModelStage)) {
    throw new Error("Database returned an invalid model stage.");
  }
  return value as ModelStage;
}

function toWatchlistInstrument(row: WatchlistRow): WatchlistInstrument {
  if (row.instrument_currency !== "INR") {
    throw new Error("Database returned an invalid instrument currency.");
  }
  return {
    researchOnly: true,
    id: asNonBlankText(row.instrument_id, "instrument id"),
    exchange: asScannerExchange(row.instrument_exchange),
    symbol: asNonBlankText(row.instrument_symbol, "instrument symbol"),
    displayName: asNonBlankText(row.instrument_display_name, "instrument display name"),
    instrumentType: asInstrumentType(row.instrument_type),
    currency: "INR",
    timezone: asNonBlankText(row.instrument_timezone, "instrument timezone"),
    tickSize: asPositiveNumber(row.instrument_tick_size, "instrument tick size"),
    lotSize: asPositiveInteger(row.instrument_lot_size, "instrument lot size"),
    registryStatus: "ACTIVE",
  };
}

function toCompletedCandle(row: MarketScannerDatabaseRow): ScannerCompletedCandle {
  const open = asPositiveNumber(row.candle_open, "candle open");
  const high = asPositiveNumber(row.candle_high, "candle high");
  const low = asPositiveNumber(row.candle_low, "candle low");
  const close = asPositiveNumber(row.candle_close, "candle close");
  if (high < open || high < close || high < low || low > open || low > close) {
    throw new Error("Database returned an invalid completed candle.");
  }
  const openTime = asDate(row.candle_open_time, "candle open time");
  const closeTime = asDate(row.candle_close_time, "candle close time");
  if (closeTime <= openTime) {
    throw new Error("Database returned an invalid completed candle time range.");
  }
  return {
    id: asNonBlankText(row.candle_id, "candle id"),
    timeframe: asNonBlankText(row.candle_timeframe, "candle timeframe"),
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume: asNonNegativeNumber(row.candle_volume, "candle volume"),
  };
}

function toIndicators(value: unknown): ScannerIndicator[] {
  return asArray(value, "scanner indicators").map((item) => {
    const row = asRecord(item, "scanner indicator");
    return {
      code: asIndicatorCode(row.code),
      algorithmVersion: asNonBlankText(row.algorithmVersion, "indicator algorithm version"),
      parameters: asIndicatorParameters(row.parameters),
      values: asIndicatorValues(row.values),
    };
  });
}

function toPatterns(value: unknown): ScannerPattern[] {
  return asArray(value, "scanner patterns").map((item) => {
    const row = asRecord(item, "scanner pattern");
    return {
      code: asPatternCode(row.code),
      algorithmVersion: asNonBlankText(row.algorithmVersion, "pattern algorithm version"),
      direction: asDirection(row.direction, "pattern direction"),
      confidence: asUnknownConfidence(row.confidence, "pattern confidence"),
    };
  });
}

function toPriceActionEvents(value: unknown): ScannerPriceActionEvent[] {
  return asArray(value, "scanner price-action events").map((item) => {
    const row = asRecord(item, "scanner price-action event");
    const level = row.level;
    if (level !== null && level !== undefined && typeof level !== "string" && typeof level !== "number") {
      throw new Error("Database returned an invalid price-action level.");
    }
    return {
      eventType: asPriceActionEventCode(row.eventType),
      algorithmVersion: asNonBlankText(row.algorithmVersion, "price-action algorithm version"),
      direction: asDirection(row.direction, "price-action direction"),
      level: level === null || level === undefined ? null : asPositiveNumber(level, "price-action level"),
      confidence: asUnknownConfidence(row.confidence, "price-action confidence"),
    };
  });
}

function toModelPrediction(row: MarketScannerDatabaseRow): ScannerModelPrediction | null {
  if (row.prediction_id === null) {
    return null;
  }
  if (
    row.prediction_label === null
    || row.prediction_confidence === null
    || row.prediction_created_at === null
    || row.prediction_evidence_cutoff_at === null
    || row.model_key === null
    || row.model_version === null
    || row.model_algorithm === null
    || row.model_current_stage === null
  ) {
    throw new Error("Database returned incomplete model prediction evidence.");
  }
  return {
    id: asNonBlankText(row.prediction_id, "prediction id"),
    prediction: asPredictionLabel(row.prediction_label),
    confidence: asConfidence(row.prediction_confidence, "prediction confidence"),
    createdAt: asDate(row.prediction_created_at, "prediction created at"),
    evidenceCutoffAt: asDate(row.prediction_evidence_cutoff_at, "prediction evidence cutoff"),
    model: {
      key: asNonBlankText(row.model_key, "model key"),
      version: asPositiveInteger(row.model_version, "model version"),
      algorithm: asNonBlankText(row.model_algorithm, "model algorithm"),
      currentStage: asModelStage(row.model_current_stage),
    },
  };
}

function toMarketScannerRow(row: MarketScannerDatabaseRow): MarketScannerProjectionRow {
  return {
    researchOnly: true,
    instrument: {
      id: asNonBlankText(row.instrument_id, "instrument id"),
      exchange: asScannerExchange(row.instrument_exchange),
      symbol: asNonBlankText(row.instrument_symbol, "instrument symbol"),
      displayName: asNonBlankText(row.instrument_display_name, "instrument display name"),
      instrumentType: asInstrumentType(row.instrument_type),
    },
    latestCompletedCandle: toCompletedCandle(row),
    indicators: toIndicators(row.indicators),
    patterns: toPatterns(row.patterns),
    priceActionEvents: toPriceActionEvents(row.price_action_events),
    modelPrediction: toModelPrediction(row),
  };
}

function toActiveResearchStrategy(row: ActiveResearchStrategyRow): ActiveResearchStrategy {
  return {
    key: asNonBlankText(row.strategy_key, "strategy key"),
    name: asNonBlankText(row.strategy_name, "strategy name"),
    version: asPositiveInteger(row.strategy_version, "strategy version"),
  };
}

/**
 * Read-model projection for the local scanner and active instrument registry.
 * Every statement is parameterized SELECT-only SQL over already-persisted data.
 */
export class PostgresMarketScannerQueryRepository implements MarketScannerQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listWatchlist(input: ListWatchlistInput): Promise<WatchlistInstrument[]> {
    const result = await this.database.query<WatchlistRow>(`
      SELECT
        i.id AS instrument_id,
        i.exchange AS instrument_exchange,
        i.symbol AS instrument_symbol,
        i.display_name AS instrument_display_name,
        i.instrument_type,
        i.currency AS instrument_currency,
        i.timezone AS instrument_timezone,
        i.tick_size AS instrument_tick_size,
        i.lot_size AS instrument_lot_size
      FROM instruments i
      WHERE i.is_active = TRUE
        AND ($1::text IS NULL OR i.exchange = $1)
        AND ($2::text IS NULL OR i.instrument_type = $2)
        AND (
          $3::text IS NULL
          OR i.exchange > $3
          OR (i.exchange = $3 AND i.symbol > $4)
          OR (i.exchange = $3 AND i.symbol = $4 AND i.id > $5::uuid)
        )
      ORDER BY i.exchange ASC, i.symbol ASC, i.id ASC
      LIMIT $6::integer
    `, [
      input.exchange ?? null,
      input.instrumentType ?? null,
      input.cursor?.exchange ?? null,
      input.cursor?.symbol ?? null,
      input.cursor?.id ?? null,
      input.limit,
    ]);
    return result.rows.map(toWatchlistInstrument);
  }

  async listScannerRows(input: ListMarketScannerInput): Promise<MarketScannerProjectionRow[]> {
    const result = await this.database.query<MarketScannerDatabaseRow>(`
      WITH latest_completed_candles AS (
        SELECT DISTINCT ON (c.instrument_id)
          c.id,
          c.instrument_id,
          c.timeframe,
          c.open_time,
          c.close_time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume
        FROM candles c
        INNER JOIN instruments i ON i.id = c.instrument_id
        WHERE c.is_complete = TRUE
          -- A completed flag alone is not sufficient: neither the candle's
          -- close nor its persisted receipt may still be in the future.
          AND c.close_time <= CURRENT_TIMESTAMP
          AND c.received_at <= CURRENT_TIMESTAMP
          AND c.timeframe = $1
          AND i.is_active = TRUE
          AND ($2::text IS NULL OR i.symbol = $2)
          AND ($3::text IS NULL OR i.exchange = $3)
        ORDER BY c.instrument_id ASC, c.close_time DESC, c.id DESC
      )
      SELECT
        i.id AS instrument_id,
        i.exchange AS instrument_exchange,
        i.symbol AS instrument_symbol,
        i.display_name AS instrument_display_name,
        i.instrument_type,
        c.id AS candle_id,
        c.timeframe AS candle_timeframe,
        c.open_time AS candle_open_time,
        c.close_time AS candle_close_time,
        c.open AS candle_open,
        c.high AS candle_high,
        c.low AS candle_low,
        c.close AS candle_close,
        c.volume AS candle_volume,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'code', indicator_definitions.indicator_code,
              'algorithmVersion', indicator_definitions.algorithm_version,
              'parameters', indicator_definitions.parameters,
              'values', indicator_snapshots.values
            )
            ORDER BY
              indicator_definitions.indicator_code ASC,
              indicator_definitions.algorithm_version ASC,
              indicator_definitions.parameters_hash ASC
          )
          FROM indicator_snapshots
          INNER JOIN indicator_definitions
            ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
          WHERE indicator_snapshots.candle_id = c.id
            AND indicator_snapshots.calculated_at <= CURRENT_TIMESTAMP
            AND (
              indicator_definitions.indicator_code NOT IN (
                'FVG', 'BOS', 'CHOCH', 'LIQUIDITY_SWEEP', 'ORDER_BLOCK', 'EQUILIBRIUM_ZONE'
              )
              OR indicator_definitions.algorithm_version = 'smc-v2'
            )
        ), '[]'::jsonb) AS indicators,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'code', pattern_definitions.pattern_code,
              'algorithmVersion', pattern_definitions.algorithm_version,
              'direction', pattern_detections.direction,
              'confidence', pattern_detections.confidence
            )
            ORDER BY pattern_definitions.pattern_code ASC, pattern_definitions.algorithm_version ASC
          )
          FROM pattern_detections
          INNER JOIN pattern_definitions
            ON pattern_definitions.id = pattern_detections.pattern_definition_id
          WHERE pattern_detections.candle_id = c.id
            AND pattern_detections.detected_at <= CURRENT_TIMESTAMP
        ), '[]'::jsonb) AS patterns,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'eventType', price_action_events.event_type,
              'algorithmVersion', price_action_events.algorithm_version,
              'direction', price_action_events.direction,
              'level', price_action_events.level,
              'confidence', price_action_events.confidence
            )
            ORDER BY price_action_events.event_type ASC, price_action_events.algorithm_version ASC
          )
          FROM price_action_events
          WHERE price_action_events.candle_id = c.id
            AND price_action_events.detected_at <= CURRENT_TIMESTAMP
        ), '[]'::jsonb) AS price_action_events,
        latest_prediction.id AS prediction_id,
        latest_prediction.prediction AS prediction_label,
        latest_prediction.confidence AS prediction_confidence,
        latest_prediction.created_at AS prediction_created_at,
        latest_prediction.evidence_cutoff_at AS prediction_evidence_cutoff_at,
        latest_model.model_key,
        latest_model.version AS model_version,
        latest_model.algorithm AS model_algorithm,
        latest_model.stage AS model_current_stage
      FROM latest_completed_candles c
      INNER JOIN instruments i ON i.id = c.instrument_id
      LEFT JOIN LATERAL (
        SELECT
          mp.id,
          mp.prediction,
          mp.confidence,
          mp.created_at,
          mp.evidence_cutoff_at,
          mp.model_version_id
        FROM model_predictions mp
        -- PRODUCTION only: with the daily model competition, SECONDARY and
        -- COMPETITOR pool members shadow-predict on the same candles. Only the
        -- PRIMARY (the sole PRODUCTION version) may surface a trade direction.
        INNER JOIN model_versions pmv
          ON pmv.id = mp.model_version_id AND pmv.stage = 'PRODUCTION'
        WHERE mp.instrument_id = c.instrument_id
          AND mp.source_candle_id = c.id
          AND mp.created_at <= CURRENT_TIMESTAMP
          AND mp.evidence_cutoff_at <= CURRENT_TIMESTAMP
        ORDER BY mp.created_at DESC, mp.id DESC
        LIMIT 1
      ) latest_prediction ON TRUE
      LEFT JOIN model_versions latest_model ON latest_model.id = latest_prediction.model_version_id
      WHERE ($4::text IS NULL OR latest_prediction.prediction = $4)
        AND (
          $5::timestamptz IS NULL
          OR date_trunc('milliseconds', c.close_time) < $5
          OR (
            date_trunc('milliseconds', c.close_time) = $5
            AND c.instrument_id < $6::uuid
          )
        )
      -- JavaScript cursors preserve milliseconds, so query comparison and
      -- ordering deliberately use the same normalized close-time key.
      ORDER BY date_trunc('milliseconds', c.close_time) DESC, c.instrument_id DESC
      LIMIT $7::integer
    `, [
      input.timeframe,
      input.instrumentSymbol ?? null,
      input.exchange ?? null,
      input.prediction ?? null,
      input.cursor?.closeTime ?? null,
      input.cursor?.instrumentId ?? null,
      input.limit,
    ]);
    return result.rows.map(toMarketScannerRow);
  }

  async listActiveResearchStrategies(): Promise<ActiveResearchStrategy[]> {
    const result = await this.database.query<ActiveResearchStrategyRow>(`
      SELECT
        strategies.strategy_key,
        strategies.name AS strategy_name,
        strategy_versions.version AS strategy_version
      FROM strategies
      INNER JOIN strategy_versions ON strategy_versions.strategy_id = strategies.id
      WHERE strategies.is_archived = FALSE
        AND strategy_versions.is_active = TRUE
      ORDER BY strategies.strategy_key ASC, strategy_versions.version DESC
    `);
    return result.rows.map(toActiveResearchStrategy);
  }
}
