import { readFile as readFileFromDisk } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { HistoricalMarketCandle, HistoricalMarketDataProvider, HistoricalMarketDataRequest } from "../../modules/market-data/domain/historical-data-provider.js";

type CsvRecord = Record<string, string>;
type ReadFile = (path: string, encoding: BufferEncoding) => Promise<string>;

export interface CsvHistoricalDataProviderOptions {
  filePath: string;
  /** Used for tests and alternative local storage adapters. */
  readFile?: ReadFile;
}

const timeframeDurationMs: Record<HistoricalMarketDataRequest["timeframe"], number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
  "1d": 6 * 60 * 60_000 + 15 * 60_000,
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueFor(record: CsvRecord, aliases: string[], required = true): string {
  const matchingHeader = Object.keys(record).find((header) => aliases.includes(normalizeHeader(header)));
  const value = matchingHeader ? record[matchingHeader]?.trim() : undefined;
  if (value) {
    return value;
  }
  if (!required) {
    return "0";
  }
  throw new Error(`CSV column ${aliases.join("/")} is required.`);
}

function decimal(value: string, field: string): string {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`CSV ${field} value "${value}" is not a non-negative decimal.`);
  }
  return normalized;
}

function nseTimestamp(year: number, month: number, day: number, hour: number, minute: number, second = 0): Date {
  // India has no daylight-saving adjustment; IST is always UTC+05:30.
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute - 30, second));
}

function parseNseTimestamp(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return nseTimestamp(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 9, 15);
  }

  const dayFirst = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value);
  if (dayFirst) {
    return nseTimestamp(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]), 9, 15);
  }

  const localTimestamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (localTimestamp) {
    return nseTimestamp(
      Number(localTimestamp[1]),
      Number(localTimestamp[2]),
      Number(localTimestamp[3]),
      Number(localTimestamp[4]),
      Number(localTimestamp[5]),
      Number(localTimestamp[6] ?? "0"),
    );
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`CSV timestamp "${value}" is invalid. Use ISO-8601 or a day-first NSE date.`);
  }
  return timestamp;
}

function closeTime(openTime: Date, timeframe: HistoricalMarketDataRequest["timeframe"]): Date {
  return new Date(openTime.getTime() + timeframeDurationMs[timeframe]);
}

/**
 * Imports common OHLCV CSV exports. It reads data locally, so it is the safe
 * default while a user chooses a licensed market-data provider.
 */
export class CsvHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = "csv-import";
  private readonly readFile: ReadFile;

  constructor(private readonly options: CsvHistoricalDataProviderOptions) {
    this.readFile = options.readFile ?? readFileFromDisk;
  }

  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]> {
    const source = await this.readFile(this.options.filePath, "utf8");
    const records = parse(source, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }) as CsvRecord[];

    return records.map((record) => {
      const openTime = parseNseTimestamp(valueFor(record, ["date", "datetime", "timestamp", "time"]));
      return {
        openTime,
        closeTime: closeTime(openTime, request.timeframe),
        open: decimal(valueFor(record, ["open"]), "Open"),
        high: decimal(valueFor(record, ["high"]), "High"),
        low: decimal(valueFor(record, ["low"]), "Low"),
        close: decimal(valueFor(record, ["close"]), "Close"),
        // Broad index exports often omit volume; persist zero rather than inventing a value.
        volume: decimal(valueFor(record, ["volume", "shares", "sharestraded"], false), "Volume"),
      };
    }).filter((candle) => candle.openTime >= request.from && candle.openTime <= request.to);
  }
}
