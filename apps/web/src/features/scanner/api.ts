import { asNumber, asObject, asString, objectAt } from "../research/json";
import type {
  CompletedCandle,
  ScannerContext,
  ScannerIndicator,
  ScannerInstrument,
  ScannerModelPrediction,
  ScannerPattern,
  ScannerPriceActionEvent,
  ScannerRow,
  WatchlistInstrument,
} from "./domain";

function parseWatchlistInstrument(value: unknown): WatchlistInstrument | null {
  const record = asObject(value);
  if (!record || record.researchOnly !== true) return null;
  const id = asString(record.id);
  const exchange = asString(record.exchange);
  const symbol = asString(record.symbol);
  const displayName = asString(record.displayName);
  const instrumentType = asString(record.instrumentType);
  const currency = asString(record.currency);
  const timezone = asString(record.timezone);
  const tickSize = asNumber(record.tickSize);
  const lotSize = asNumber(record.lotSize);
  const registryStatus = asString(record.registryStatus);
  if (!id || !exchange || !symbol || !displayName || !instrumentType || !currency || !timezone || tickSize === null || lotSize === null || !registryStatus) return null;

  return {
    id,
    researchOnly: true,
    exchange,
    symbol,
    displayName,
    instrumentType,
    currency,
    timezone,
    tickSize,
    lotSize,
    registryStatus,
  };
}

function parseCompletedCandle(value: unknown): CompletedCandle | null {
  const candle = asObject(value);
  if (!candle) return null;
  const id = asString(candle.id);
  const timeframe = asString(candle.timeframe);
  const openTime = asString(candle.openTime);
  const closeTime = asString(candle.closeTime);
  const open = asNumber(candle.open);
  const high = asNumber(candle.high);
  const low = asNumber(candle.low);
  const close = asNumber(candle.close);
  const volume = asNumber(candle.volume);
  if (!id || !timeframe || !openTime || !closeTime || open === null || high === null || low === null || close === null || volume === null) return null;
  return { id, timeframe, openTime, closeTime, open, high, low, close, volume };
}

function parseScannerInstrument(value: unknown): ScannerInstrument | null {
  const instrument = asObject(value);
  if (!instrument) return null;
  const id = asString(instrument.id);
  const exchange = asString(instrument.exchange);
  const symbol = asString(instrument.symbol);
  const displayName = asString(instrument.displayName);
  const instrumentType = asString(instrument.instrumentType);
  if (!id || !exchange || !symbol || !displayName || !instrumentType) return null;
  return { id, exchange, symbol, displayName, instrumentType };
}

function parseIndicator(value: unknown): ScannerIndicator | null {
  const indicator = asObject(value);
  const code = indicator && asString(indicator.code);
  const algorithmVersion = indicator && asString(indicator.algorithmVersion);
  if (!indicator || !code || !algorithmVersion) return null;
  return { code, algorithmVersion, parameters: objectAt(indicator, "parameters"), values: objectAt(indicator, "values") };
}

function parsePattern(value: unknown): ScannerPattern | null {
  const pattern = asObject(value);
  const code = pattern && asString(pattern.code);
  const algorithmVersion = pattern && asString(pattern.algorithmVersion);
  const direction = pattern && asString(pattern.direction);
  const confidence = pattern && asNumber(pattern.confidence);
  if (!pattern || !code || !algorithmVersion || !direction || confidence === null) return null;
  return { code, algorithmVersion, direction, confidence };
}

function parsePriceActionEvent(value: unknown): ScannerPriceActionEvent | null {
  const event = asObject(value);
  const eventType = event && asString(event.eventType);
  const algorithmVersion = event && asString(event.algorithmVersion);
  const direction = event && asString(event.direction);
  const confidence = event && asNumber(event.confidence);
  if (!event || !eventType || !algorithmVersion || !direction || confidence === null) return null;
  const level = event.level === null ? null : asNumber(event.level);
  if (level === null && event.level !== null) return null;
  return { eventType, algorithmVersion, direction, level, confidence };
}

function parseModelPrediction(value: unknown): ScannerModelPrediction | null {
  if (value === null) return null;
  const prediction = asObject(value);
  if (!prediction) return null;
  const id = asString(prediction.id);
  const label = asString(prediction.prediction);
  const confidence = asNumber(prediction.confidence);
  const createdAt = asString(prediction.createdAt);
  const evidenceCutoffAt = asString(prediction.evidenceCutoffAt);
  const model = objectAt(prediction, "model");
  const key = asString(model.key);
  const version = asNumber(model.version);
  const algorithm = asString(model.algorithm);
  const currentStage = asString(model.currentStage);
  if (!id || !label || confidence === null || !createdAt || !evidenceCutoffAt || !key || version === null || !algorithm || !currentStage) return null;
  return {
    id,
    prediction: label,
    confidence,
    createdAt,
    evidenceCutoffAt,
    model: { key, version, algorithm, currentStage },
  };
}

function parseRequiredArray<T>(value: unknown, parser: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(parser);
  return records.every((record): record is T => record !== null) ? records : null;
}

function parseScannerRow(value: unknown): ScannerRow | null {
  const record = asObject(value);
  if (!record || record.researchOnly !== true) return null;
  const instrument = parseScannerInstrument(record.instrument);
  const latestCompletedCandle = parseCompletedCandle(record.latestCompletedCandle);
  const indicators = parseRequiredArray(record.indicators, parseIndicator);
  const patterns = parseRequiredArray(record.patterns, parsePattern);
  const priceActionEvents = parseRequiredArray(record.priceActionEvents, parsePriceActionEvent);
  const modelPrediction = parseModelPrediction(record.modelPrediction);
  if (!instrument || !latestCompletedCandle || !indicators || !patterns || !priceActionEvents || (record.modelPrediction !== null && !modelPrediction)) return null;
  return { researchOnly: true, instrument, latestCompletedCandle, indicators, patterns, priceActionEvents, modelPrediction };
}

function parseListEnvelope<T>(value: unknown, parser: (record: unknown) => T | null): T[] {
  const envelope = asObject(value);
  if (!envelope || !Array.isArray(envelope.data)) {
    throw new Error("The local API response does not contain a data array.");
  }
  const records = envelope.data.map(parser);
  if (!records.every((record): record is T => record !== null)) {
    throw new Error("The local API returned a record outside the read-only dashboard contract.");
  }
  return records;
}

function parseScannerContext(value: unknown): ScannerContext | null {
  const context = asObject(value);
  if (!context || context.researchOnly !== true || !Array.isArray(context.activeStrategies)) return null;
  const timeframe = asString(context.timeframe);
  if (!timeframe) return null;
  const activeStrategies = context.activeStrategies.map((item) => {
    const strategy = asObject(item);
    const key = strategy && asString(strategy.key);
    const name = strategy && asString(strategy.name);
    const version = strategy && asNumber(strategy.version);
    return strategy && key && name && version !== null ? { key, name, version } : null;
  });
  if (!activeStrategies.every((strategy): strategy is { key: string; name: string; version: number } => strategy !== null)) return null;
  return { researchOnly: true, timeframe, activeStrategies };
}

export function parseWatchlistEnvelope(value: unknown): WatchlistInstrument[] {
  return parseListEnvelope(value, parseWatchlistInstrument);
}

export function parseScannerEnvelope(value: unknown): { records: ScannerRow[]; context: ScannerContext } {
  const envelope = asObject(value);
  const records = parseListEnvelope(envelope, parseScannerRow);
  const context = parseScannerContext(envelope?.context);
  if (!context) throw new Error("The local API response does not contain valid scanner context.");
  return { records, context };
}
