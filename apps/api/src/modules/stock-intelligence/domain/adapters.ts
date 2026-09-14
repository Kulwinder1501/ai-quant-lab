import type { HistoricalMarketCandle } from "../../market-data/domain/historical-data-provider.js";
import type { PointInTimeClocks } from "./timestamps.js";

/**
 * Provider ports. Intelligence engines depend on these types, never on Yahoo, BSE,
 * RBI, or NSE clients. The first MarketDataAdapter implementation wraps the existing
 * `HistoricalMarketDataProvider` (Yahoo today, Fyers/CSV tomorrow).
 *
 * Fundamental / BSE / RBI / NSE adapters are declared so Gate 1 can close. They have
 * no MVP implementation until a source that can honour PIT immutability is wired.
 */
export interface CanonicalMarketBar extends PointInTimeClocks {
  readonly instrumentId: string;
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface MarketDataAdapter {
  fetchDailyBars(input: {
    instrumentId: string;
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<readonly CanonicalMarketBar[]>;
}

export interface FundamentalDataAdapter {
  fetchAsReported(input: {
    instrumentId: string;
    dataCutoff: Date;
  }): Promise<readonly Record<string, unknown>[]>;
}

export interface BseAdapter {
  fetchCorporateActions(input: {
    instrumentId: string;
    dataCutoff: Date;
  }): Promise<readonly Record<string, unknown>[]>;
}

export interface RbiAdapter {
  fetchMacroSeries(input: {
    series: string;
    dataCutoff: Date;
  }): Promise<readonly Record<string, unknown>[]>;
}

export interface NseAdapter {
  fetchIndexBars(input: {
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<readonly CanonicalMarketBar[]>;
}

export const YAHOO_DAILY_BAR_SOURCE_KIND = "yahoo_daily_bar";

export function barFromHistoricalCandle(
  instrumentId: string,
  candle: HistoricalMarketCandle,
): CanonicalMarketBar {
  return {
    instrumentId,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    publishedAt: candle.closeTime,
    effectiveAt: candle.openTime,
    availableAt: candle.closeTime,
  };
}

export function rawPayloadFromMarketBar(bar: CanonicalMarketBar): Record<string, unknown> {
  return {
    openTime: bar.openTime.toISOString(),
    closeTime: bar.closeTime.toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    priceSeriesBasis: "split_adjusted",
  };
}

function asIsoDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export function marketBarFromRaw(
  record: { instrumentId: string | null; payload: Record<string, unknown> } & PointInTimeClocks,
): CanonicalMarketBar | null {
  if (!record.instrumentId) return null;
  const payload = record.payload;
  if (typeof payload.open !== "string" || typeof payload.close !== "string") return null;
  return {
    instrumentId: record.instrumentId,
    openTime: asIsoDate(payload.openTime, record.effectiveAt),
    closeTime: asIsoDate(payload.closeTime, record.availableAt),
    open: payload.open,
    high: typeof payload.high === "string" ? payload.high : payload.open,
    low: typeof payload.low === "string" ? payload.low : payload.close,
    close: payload.close,
    volume: typeof payload.volume === "string" ? payload.volume : "0",
    publishedAt: record.publishedAt,
    effectiveAt: record.effectiveAt,
    availableAt: record.availableAt,
  };
}
