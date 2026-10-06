import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import type { CandleRepository } from "../domain/candle.js";
import { aggregateOhlcBars, computeSyntheticDxyBar, type TimestampedOhlc } from "../domain/synthetic-dxy.js";

const COMPONENT_SYMBOLS = ["EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"] as const;
type ComponentSymbol = (typeof COMPONENT_SYMBOLS)[number];

interface CandleRow {
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
}

async function loadComponentInstrumentIds(
  database: DatabaseQueryable,
): Promise<Record<ComponentSymbol, string>> {
  const result = await database.query<{ symbol: string; id: string }>(
    `SELECT symbol, id FROM instruments WHERE exchange = 'TWELVEDATA' AND symbol = ANY($1::text[])`,
    [COMPONENT_SYMBOLS],
  );
  const ids = Object.fromEntries(result.rows.map((row) => [row.symbol, row.id])) as Record<ComponentSymbol, string>;
  const missing = COMPONENT_SYMBOLS.filter((symbol) => !ids[symbol]);
  if (missing.length > 0) {
    throw new Error(
      `Missing TWELVEDATA instrument registration for DXY component(s): ${missing.join(", ")}. `
      + "Run the 125-dxy-fx-component-instruments migration first.",
    );
  }
  return ids;
}

async function loadComponentSeries(
  database: DatabaseQueryable,
  instrumentId: string,
  from: Date,
  to: Date,
): Promise<Map<number, CandleRow>> {
  const result = await database.query<CandleRow>(
    `SELECT open_time, close_time, open, high, low, close
     FROM candles
     WHERE instrument_id = $1 AND timeframe = '1m' AND open_time >= $2 AND open_time < $3
     ORDER BY open_time ASC`,
    [instrumentId, from, to],
  );
  return new Map(result.rows.map((row) => [row.open_time.getTime(), row]));
}

async function fetchDxyInstrumentId(database: DatabaseQueryable): Promise<string> {
  const result = await database.query<{ id: string }>(
    `SELECT id FROM instruments WHERE exchange = 'TWELVEDATA' AND symbol = 'DXY'`,
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error('TWELVEDATA instrument "DXY" is not registered. Run the migrations first.');
  }
  return id;
}

export interface ComputeSyntheticDxyCandlesResult {
  oneMinuteBarsWritten: number;
  fiveMinuteBarsWritten: number;
  fifteenMinuteBarsWritten: number;
  componentMinutesMissingAnyLeg: number;
}

/**
 * Builds the synthetic DXY 1m series from its 6 real component pairs' already-collected 1m
 * candles (aligned by timestamp -- a minute missing any one leg is skipped, not forward-filled,
 * since fabricating a missing leg's rate would make every downstream DXY bar that minute
 * fictitious rather than reconstructed), then rolls the 1m series up into 5m and 15m via a real
 * OHLC aggregation. The 6 component series must already be collected (via
 * `data:collect:historical --provider twelvedata --instrument EUR_USD ...` etc.) before this
 * runs; it only reads and recombines what is already in `candles`.
 */
export async function computeSyntheticDxyCandles(
  database: DatabaseQueryable,
  candleRepository: CandleRepository,
  from: Date,
  to: Date,
): Promise<ComputeSyntheticDxyCandlesResult> {
  const componentIds = await loadComponentInstrumentIds(database);
  const dxyInstrumentId = await fetchDxyInstrumentId(database);

  const seriesBySymbol = new Map<ComponentSymbol, Map<number, CandleRow>>();
  for (const symbol of COMPONENT_SYMBOLS) {
    seriesBySymbol.set(symbol, await loadComponentSeries(database, componentIds[symbol], from, to));
  }

  const allTimestamps = new Set<number>();
  for (const series of seriesBySymbol.values()) {
    for (const timestamp of series.keys()) allTimestamps.add(timestamp);
  }

  const oneMinuteBars: TimestampedOhlc[] = [];
  let missingAnyLeg = 0;

  for (const timestamp of [...allTimestamps].sort((a, b) => a - b)) {
    const rows = COMPONENT_SYMBOLS.map((symbol) => seriesBySymbol.get(symbol)!.get(timestamp));
    if (rows.some((row) => row === undefined)) {
      missingAnyLeg += 1;
      continue;
    }
    const [eurUsd, usdJpy, gbpUsd, usdCad, usdSek, usdChf] = rows as CandleRow[];
    const bar = computeSyntheticDxyBar({
      eurUsd: { open: Number(eurUsd.open), high: Number(eurUsd.high), low: Number(eurUsd.low), close: Number(eurUsd.close) },
      usdJpy: { open: Number(usdJpy.open), high: Number(usdJpy.high), low: Number(usdJpy.low), close: Number(usdJpy.close) },
      gbpUsd: { open: Number(gbpUsd.open), high: Number(gbpUsd.high), low: Number(gbpUsd.low), close: Number(gbpUsd.close) },
      usdCad: { open: Number(usdCad.open), high: Number(usdCad.high), low: Number(usdCad.low), close: Number(usdCad.close) },
      usdSek: { open: Number(usdSek.open), high: Number(usdSek.high), low: Number(usdSek.low), close: Number(usdSek.close) },
      usdChf: { open: Number(usdChf.open), high: Number(usdChf.high), low: Number(usdChf.low), close: Number(usdChf.close) },
    });
    oneMinuteBars.push({
      openTime: new Date(timestamp),
      closeTime: eurUsd.close_time,
      ...bar,
    });
  }

  const fiveMinuteBars = aggregateOhlcBars(oneMinuteBars, 5);
  const fifteenMinuteBars = aggregateOhlcBars(oneMinuteBars, 15);

  async function writeBars(bars: TimestampedOhlc[], timeframe: string): Promise<number> {
    for (const bar of bars) {
      await candleRepository.upsert({
        instrumentId: dxyInstrumentId,
        timeframe,
        openTime: bar.openTime,
        closeTime: bar.closeTime,
        open: bar.open.toFixed(6),
        high: bar.high.toFixed(6),
        low: bar.low.toFixed(6),
        close: bar.close.toFixed(6),
        volume: "0",
        isComplete: true,
        source: "twelvedata",
        sourceMetadata: { synthetic: true, formula: "ICE_DXY_V1", components: COMPONENT_SYMBOLS },
      });
    }
    return bars.length;
  }

  return {
    oneMinuteBarsWritten: await writeBars(oneMinuteBars, "1m"),
    fiveMinuteBarsWritten: await writeBars(fiveMinuteBars, "5m"),
    fifteenMinuteBarsWritten: await writeBars(fifteenMinuteBars, "15m"),
    componentMinutesMissingAnyLeg: missingAnyLeg,
  };
}
