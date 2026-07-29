import type {
  ActiveResearchStrategy,
  ListMarketScannerInput,
  MarketScannerCursor,
  MarketScannerQueryRepository,
  MarketScannerRow,
  ScannerExchange,
} from "../domain/market-scanner.js";
import { scannerExchanges } from "../domain/market-scanner.js";
import type { ModelPredictionLabel } from "../../model-predictions/domain/model-prediction.js";
import { InvalidMarketScannerQueryError, maximumWatchlistLimit } from "./list-watchlist.js";

export const defaultMarketScannerLimit = 50;
export const defaultScannerTimeframe = "1d";

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

function normalizeExchange(value: string | undefined): ScannerExchange | undefined {
  const normalized = normalizeOptionalText(value, "exchange")?.toUpperCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (!scannerExchanges.includes(normalized as ScannerExchange)) {
    throw new InvalidMarketScannerQueryError("exchange must be NSE, NFO, or BSE.");
  }
  return normalized as ScannerExchange;
}

function normalizeSymbol(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value, "instrument");
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized.length > 128) {
    throw new InvalidMarketScannerQueryError("instrument must be at most 128 characters.");
  }
  return normalized.toUpperCase();
}

function normalizeTimeframe(value: string | undefined): string {
  const normalized = (value ?? defaultScannerTimeframe).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,15}$/.test(normalized)) {
    throw new InvalidMarketScannerQueryError(
      "timeframe must be 2 to 16 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return normalized;
}

function normalizePrediction(value: string | undefined): ModelPredictionLabel | undefined {
  const normalized = normalizeOptionalText(value, "prediction")?.toUpperCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(normalized)) {
    throw new InvalidMarketScannerQueryError("prediction must be BULLISH, BEARISH, or NEUTRAL.");
  }
  return normalized as ModelPredictionLabel;
}

function validateUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidMarketScannerQueryError(`${field} must be a UUID.`);
  }
  return value;
}

function normalizeCursor(cursor: MarketScannerCursor | undefined): MarketScannerCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  if (Number.isNaN(cursor.closeTime.getTime())) {
    throw new InvalidMarketScannerQueryError("cursor closeTime must be a valid ISO-8601 timestamp.");
  }
  return {
    closeTime: cursor.closeTime,
    instrumentId: validateUuid(cursor.instrumentId.trim(), "cursor instrument id"),
  };
}

export class ListMarketScanner {
  constructor(private readonly repository: MarketScannerQueryRepository) {}

  async execute(input: Partial<ListMarketScannerInput> = {}): Promise<{
    records: MarketScannerRow[];
    limit: number;
    nextCursor: MarketScannerCursor | null;
    activeStrategies: ActiveResearchStrategy[];
    timeframe: string;
  }> {
    const limit = input.limit ?? defaultMarketScannerLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumWatchlistLimit) {
      throw new InvalidMarketScannerQueryError(
        `limit must be an integer between 1 and ${maximumWatchlistLimit}.`,
      );
    }
    const timeframe = normalizeTimeframe(input.timeframe);
    const query: ListMarketScannerInput = {
      timeframe,
      instrumentSymbol: normalizeSymbol(input.instrumentSymbol),
      exchange: normalizeExchange(input.exchange),
      prediction: normalizePrediction(input.prediction),
      cursor: normalizeCursor(input.cursor),
      limit: limit + 1,
    };

    const [candidates, activeStrategies] = await Promise.all([
      this.repository.listScannerRows(query),
      this.repository.listActiveResearchStrategies(),
    ]);
    const records = candidates.slice(0, limit);
    const lastRecord = records.at(-1);
    return {
      records,
      limit,
      nextCursor: candidates.length > limit && lastRecord
        ? {
          closeTime: lastRecord.latestCompletedCandle.closeTime,
          instrumentId: lastRecord.instrument.id,
        }
        : null,
      activeStrategies,
      timeframe,
    };
  }
}
