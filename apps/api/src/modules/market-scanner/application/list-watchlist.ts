import type {
  ListWatchlistInput,
  MarketScannerQueryRepository,
  ScannerExchange,
  WatchlistCursor,
  WatchlistInstrument,
} from "../domain/market-scanner.js";
import { scannerExchanges } from "../domain/market-scanner.js";
import { instrumentTypes, type InstrumentType } from "../../market-data/domain/instrument.js";

export const defaultWatchlistLimit = 50;
export const maximumWatchlistLimit = 100;

/** Raised when a caller supplies a query that cannot safely select stored research data. */
export class InvalidMarketScannerQueryError extends Error {}

function normalizeOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidMarketScannerQueryError(`${field} must not be blank.`);
  }
  return normalized;
}

function normalizeExchange(value: string | undefined, field: string): ScannerExchange | undefined {
  const normalized = normalizeOptionalText(value, field)?.toUpperCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (!scannerExchanges.includes(normalized as ScannerExchange)) {
    throw new InvalidMarketScannerQueryError(`${field} must be NSE, NFO, or BSE.`);
  }
  return normalized as ScannerExchange;
}

function normalizeInstrumentType(value: string | undefined): InstrumentType | undefined {
  const normalized = normalizeOptionalText(value, "instrumentType")?.toUpperCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (!instrumentTypes.includes(normalized as InstrumentType)) {
    throw new InvalidMarketScannerQueryError("instrumentType must be INDEX, EQUITY, or ETF.");
  }
  return normalized as InstrumentType;
}

function normalizeSymbol(value: string | undefined, field: string): string | undefined {
  const normalized = normalizeOptionalText(value, field);
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized.length > 128) {
    throw new InvalidMarketScannerQueryError(`${field} must be at most 128 characters.`);
  }
  return normalized.toUpperCase();
}

function validateUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidMarketScannerQueryError(`${field} must be a UUID.`);
  }
  return value;
}

function normalizeCursor(cursor: WatchlistCursor | undefined): WatchlistCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  const exchange = normalizeExchange(cursor.exchange, "cursor exchange");
  const symbol = normalizeSymbol(cursor.symbol, "cursor symbol");
  const id = validateUuid(cursor.id.trim(), "cursor id");
  if (!exchange || !symbol) {
    throw new InvalidMarketScannerQueryError("cursor must contain an exchange, symbol, and id.");
  }
  return { exchange, symbol, id };
}

export class ListWatchlist {
  constructor(private readonly repository: MarketScannerQueryRepository) {}

  async execute(input: Partial<ListWatchlistInput> = {}): Promise<{
    records: WatchlistInstrument[];
    limit: number;
    nextCursor: WatchlistCursor | null;
  }> {
    const limit = input.limit ?? defaultWatchlistLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumWatchlistLimit) {
      throw new InvalidMarketScannerQueryError(
        `limit must be an integer between 1 and ${maximumWatchlistLimit}.`,
      );
    }

    const candidates = await this.repository.listWatchlist({
      exchange: normalizeExchange(input.exchange, "exchange"),
      instrumentType: normalizeInstrumentType(input.instrumentType),
      cursor: normalizeCursor(input.cursor),
      // Fetch one more row than requested to make a deterministic cursor without a COUNT query.
      limit: limit + 1,
    });
    const records = candidates.slice(0, limit);
    const lastRecord = records.at(-1);
    return {
      records,
      limit,
      nextCursor: candidates.length > limit && lastRecord
        ? { exchange: lastRecord.exchange, symbol: lastRecord.symbol, id: lastRecord.id }
        : null,
    };
  }
}
