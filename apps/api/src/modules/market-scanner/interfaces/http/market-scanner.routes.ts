import type { Express, Request } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import {
  InvalidHttpQueryError,
  parseLimit,
  parseUtcTimestamp,
  queryString,
} from "../../../../interfaces/http/common/query.js";
import { InvalidMarketScannerQueryError } from "../../application/list-watchlist.js";
import type { MarketScannerCursor, ScannerExchange, WatchlistCursor } from "../../domain/market-scanner.js";
import type { ModelPredictionLabel } from "../../../model-predictions/domain/model-prediction.js";

function parseWatchlistQuery(request: Request): {
  exchange?: ScannerExchange;
  instrumentType?: "INDEX" | "EQUITY" | "ETF";
  limit?: number;
  cursor?: WatchlistCursor;
} {
  const cursorExchange = queryString(request, "cursorExchange");
  const cursorSymbol = queryString(request, "cursorSymbol");
  const cursorId = queryString(request, "cursorId");
  const cursorValues = [cursorExchange, cursorSymbol, cursorId];
  if (cursorValues.some((value) => value === undefined) && cursorValues.some((value) => value !== undefined)) {
    throw new InvalidHttpQueryError("cursorExchange, cursorSymbol, and cursorId must be supplied together.");
  }
  return {
    exchange: queryString(request, "exchange")?.toUpperCase() as ScannerExchange | undefined,
    instrumentType: queryString(request, "instrumentType")?.toUpperCase() as "INDEX" | "EQUITY" | "ETF" | undefined,
    limit: parseLimit(request),
    cursor: cursorExchange !== undefined && cursorSymbol !== undefined && cursorId !== undefined
      ? { exchange: cursorExchange.toUpperCase() as ScannerExchange, symbol: cursorSymbol.toUpperCase(), id: cursorId }
      : undefined,
  };
}

function parseMarketScannerQuery(request: Request): {
  timeframe?: string;
  instrumentSymbol?: string;
  exchange?: ScannerExchange;
  prediction?: ModelPredictionLabel;
  limit?: number;
  cursor?: MarketScannerCursor;
} {
  const cursorCloseTime = queryString(request, "cursorCloseTime");
  const cursorInstrumentId = queryString(request, "cursorInstrumentId");
  if ((cursorCloseTime === undefined) !== (cursorInstrumentId === undefined)) {
    throw new InvalidHttpQueryError("cursorCloseTime and cursorInstrumentId must be supplied together.");
  }
  return {
    timeframe: queryString(request, "timeframe"),
    instrumentSymbol: queryString(request, "instrument"),
    exchange: queryString(request, "exchange")?.toUpperCase() as ScannerExchange | undefined,
    prediction: queryString(request, "prediction")?.toUpperCase() as ModelPredictionLabel | undefined,
    limit: parseLimit(request),
    cursor: cursorCloseTime !== undefined && cursorInstrumentId !== undefined
      ? { closeTime: parseUtcTimestamp(cursorCloseTime, "cursorCloseTime"), instrumentId: cursorInstrumentId }
      : undefined,
  };
}

export function registerMarketScannerRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "listWatchlist" | "listMarketScanner">,
): void {
  app.get("/api/v1/watchlist", async (request, response, next) => {
    try {
      const result = await dependencies.listWatchlist.execute(parseWatchlistQuery(request));
      response.status(200).json({ data: result.records, page: { limit: result.limit, nextCursor: result.nextCursor } });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidMarketScannerQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/market-scanner", async (request, response, next) => {
    try {
      const result = await dependencies.listMarketScanner.execute(parseMarketScannerQuery(request));
      response.status(200).json({
        data: result.records,
        page: { limit: result.limit, nextCursor: result.nextCursor },
        context: { researchOnly: true, timeframe: result.timeframe, activeStrategies: result.activeStrategies },
      });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidMarketScannerQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
}
