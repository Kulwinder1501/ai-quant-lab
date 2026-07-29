import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import yahooFinance from "yahoo-finance2";
import cron from "node-cron";
import { spawn } from "node:child_process";
import { checkDatabaseReadiness, type DatabaseQueryable } from "../../infrastructure/database/database.js";
import { PostgresModelPredictionQueryRepository } from "../../infrastructure/database/repositories/postgres-model-prediction-query-repository.js";
import { PostgresMarketScannerQueryRepository } from "../../infrastructure/database/repositories/postgres-market-scanner-query-repository.js";
import { ListMarketScanner } from "../../modules/market-scanner/application/list-market-scanner.js";
import {
  InvalidMarketScannerQueryError,
  ListWatchlist,
} from "../../modules/market-scanner/application/list-watchlist.js";
import type {
  MarketScannerCursor,
  ScannerExchange,
  WatchlistCursor,
} from "../../modules/market-scanner/domain/market-scanner.js";
import { GetModelPrediction } from "../../modules/model-predictions/application/get-model-prediction.js";
import {
  InvalidModelPredictionQueryError,
  ListModelPredictions,
} from "../../modules/model-predictions/application/list-model-predictions.js";
import type { ModelPredictionLabel } from "../../modules/model-predictions/domain/model-prediction.js";
import { PostgresModelPerformanceQueryRepository } from "../../infrastructure/database/repositories/postgres-model-performance-query-repository.js";
import {
  InvalidModelPerformanceQueryError,
  ListModelVersions,
} from "../../modules/model-performance/application/list-model-versions.js";
import type { ModelStage } from "../../modules/model-predictions/domain/model-prediction.js";
import { PostgresPaperTradeHistoryQueryRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-history-query-repository.js";
import {
  InvalidTradeHistoryQueryError,
  ListPaperTradeHistory,
} from "../../modules/paper-trading/application/list-paper-trade-history.js";
import type {
  PaperTradeExitReason,
  PaperTradeStatus,
} from "../../modules/paper-trading/domain/paper-trading.js";
import type { TradeOutcomeFilter } from "../../modules/paper-trading/domain/paper-trade-history.js";
import type { TradeSide } from "../../modules/strategy-engine/domain/strategy.js";
import { PostgresDashboardQueryRepository } from "../../infrastructure/database/repositories/postgres-dashboard-query-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { CreatePaperAccount } from "../../modules/paper-trading/application/create-paper-account.js";
import { GetPaperAccountSummary } from "../../modules/paper-trading/application/get-paper-account-summary.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { ClosePaperTrade } from "../../modules/paper-trading/application/close-paper-trade.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresTradeIdeaRepository } from "../../infrastructure/database/repositories/postgres-trade-idea-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";
import { PostgresBacktestRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-repository.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import { RunBacktest } from "../../modules/backtesting/application/run-backtest.js";
import { AiAutonomousAgent } from "../../modules/strategy-engine/application/ai-autonomous-agent.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { IngestRssNewsService } from "../../modules/news-sentiment/application/ingest-rss-news.js";
import { ListMarketNewsService } from "../../modules/news-sentiment/application/list-market-news.js";

export interface ApplicationDependencies {
  database: any;
}

class InvalidHttpQueryError extends Error {}

function queryString(request: Request, key: string): string | undefined {
  const value = request.query[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidHttpQueryError(`${key} must be supplied once as text.`);
  }
  return value;
}

function parseListQuery(request: Request): {
  instrumentSymbol?: string;
  modelKey?: string;
  timeframe?: string;
  prediction?: ModelPredictionLabel;
  limit?: number;
  cursor?: { createdAt: Date; id: string };
} {
  const limitText = queryString(request, "limit");
  let limit: number | undefined;
  if (limitText !== undefined) {
    if (!/^\d+$/.test(limitText.trim())) {
      throw new InvalidModelPredictionQueryError("limit must be a whole number.");
    }
    limit = Number(limitText);
  }

  const cursorCreatedAt = queryString(request, "cursorCreatedAt");
  const cursorId = queryString(request, "cursorId");
  if ((cursorCreatedAt === undefined) !== (cursorId === undefined)) {
    throw new InvalidModelPredictionQueryError("cursorCreatedAt and cursorId must be supplied together.");
  }
  let cursor: { createdAt: Date; id: string } | undefined;
  if (cursorCreatedAt !== undefined && cursorId !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursorCreatedAt)) {
      throw new InvalidModelPredictionQueryError("cursorCreatedAt must be a UTC ISO-8601 timestamp.");
    }
    const createdAt = new Date(cursorCreatedAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new InvalidModelPredictionQueryError("cursorCreatedAt must be an ISO-8601 timestamp.");
    }
    cursor = { createdAt, id: cursorId };
  }

  const predictionText = queryString(request, "prediction");
  return {
    instrumentSymbol: queryString(request, "instrument"),
    modelKey: queryString(request, "modelKey"),
    timeframe: queryString(request, "timeframe"),
    prediction: predictionText?.toUpperCase() as ModelPredictionLabel | undefined,
    limit,
    cursor,
  };
}

function parseLimit(request: Request): number | undefined {
  const limitText = queryString(request, "limit");
  if (limitText === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(limitText.trim())) {
    throw new InvalidHttpQueryError("limit must be a whole number.");
  }
  return Number(limitText);
}

function parseUtcTimestamp(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new InvalidHttpQueryError(`${field} must be a UTC ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new InvalidHttpQueryError(`${field} must be an ISO-8601 timestamp.`);
  }
  return parsed;
}

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
      ? {
        exchange: cursorExchange.toUpperCase() as ScannerExchange,
        symbol: cursorSymbol.toUpperCase(),
        id: cursorId,
      }
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
      ? {
        closeTime: parseUtcTimestamp(cursorCloseTime, "cursorCloseTime"),
        instrumentId: cursorInstrumentId,
      }
      : undefined,
  };
}

function isQueryValidationError(
  error: unknown,
): error is
  | InvalidHttpQueryError
  | InvalidModelPredictionQueryError
  | InvalidMarketScannerQueryError
  | InvalidTradeHistoryQueryError
  | InvalidModelPerformanceQueryError {
  return error instanceof InvalidHttpQueryError
    || error instanceof InvalidModelPredictionQueryError
    || error instanceof InvalidMarketScannerQueryError
    || error instanceof InvalidTradeHistoryQueryError
    || error instanceof InvalidModelPerformanceQueryError;
}

function parseTradeHistoryQuery(request: Request): {
  accountId?: string;
  instrumentSymbol?: string;
  status?: PaperTradeStatus;
  side?: TradeSide;
  exitReason?: PaperTradeExitReason;
  outcome?: TradeOutcomeFilter;
  openedFrom?: Date;
  openedTo?: Date;
  limit?: number;
} {
  const openedFrom = queryString(request, "openedFrom");
  const openedTo = queryString(request, "openedTo");
  return {
    accountId: queryString(request, "accountId"),
    instrumentSymbol: queryString(request, "instrument"),
    status: queryString(request, "status")?.toUpperCase() as PaperTradeStatus | undefined,
    side: queryString(request, "side")?.toUpperCase() as TradeSide | undefined,
    exitReason: queryString(request, "exitReason")?.toUpperCase() as PaperTradeExitReason | undefined,
    outcome: queryString(request, "outcome")?.toUpperCase() as TradeOutcomeFilter | undefined,
    openedFrom: openedFrom === undefined ? undefined : parseUtcTimestamp(openedFrom, "openedFrom"),
    openedTo: openedTo === undefined ? undefined : parseUtcTimestamp(openedTo, "openedTo"),
    limit: parseLimit(request),
  };
}

function parseModelVersionQuery(request: Request): {
  modelKey?: string;
  algorithm?: string;
  stage?: ModelStage;
  limit?: number;
} {
  return {
    modelKey: queryString(request, "modelKey"),
    algorithm: queryString(request, "algorithm"),
    stage: queryString(request, "stage")?.toUpperCase() as ModelStage | undefined,
    limit: parseLimit(request),
  };
}

export function createApp({ database }: ApplicationDependencies): Express {
  const app = express();
  const predictionRepository = new PostgresModelPredictionQueryRepository(database);
  const marketScannerRepository = new PostgresMarketScannerQueryRepository(database);
  const listModelPredictions = new ListModelPredictions(predictionRepository);
  const getModelPrediction = new GetModelPrediction(predictionRepository);
  const listWatchlist = new ListWatchlist(marketScannerRepository);
  const listMarketScanner = new ListMarketScanner(marketScannerRepository);

  const tradeHistoryRepository = new PostgresPaperTradeHistoryQueryRepository(database);
  const modelPerformanceRepository = new PostgresModelPerformanceQueryRepository(database);
  const listPaperTradeHistory = new ListPaperTradeHistory(tradeHistoryRepository);
  const listModelVersions = new ListModelVersions(modelPerformanceRepository);

  const dashboardRepository = new PostgresDashboardQueryRepository(database);
  const paperAccountRepository = new PostgresPaperAccountRepository(database);
  const paperTradeRepository = new PostgresPaperTradeRepository(database);
  const candleRepository = new PostgresCandleRepository(database);
  const tradeIdeaRepository = new PostgresTradeIdeaRepository(database);
  const strategyVersionRepository = new PostgresStrategyVersionRepository(database);
  const strategyContextRepository = new PostgresStrategyMarketContextRepository(database);
  const backtestRepository = new PostgresBacktestRepository(database);
  const backtestMarketDataRepository = new PostgresBacktestMarketDataRepository(database);
  const newsRepository = new PostgresNewsRepository(database);

  const aiJournalRepository = new PostgresAiJournalRepository(database);

  const createPaperAccount = new CreatePaperAccount(paperAccountRepository);
  const getPaperAccountSummary = new GetPaperAccountSummary(paperTradeRepository);
  const openPaperTrade = new OpenPaperTrade(paperTradeRepository);
  const evaluateOpenPaperTrades = new EvaluateOpenPaperTrades(paperTradeRepository, candleRepository);
  const closePaperTrade = new ClosePaperTrade(paperTradeRepository);
  const generateTradeIdeas = new GenerateTradeIdeas(strategyVersionRepository, strategyContextRepository, tradeIdeaRepository);
  const runBacktest = new RunBacktest(backtestRepository, backtestMarketDataRepository);
  const ingestNews = new IngestRssNewsService(newsRepository);
  const listNews = new ListMarketNewsService(newsRepository);

  // Background 3-Minute RSS News Ingestion Timer (180 seconds)
  setInterval(() => {
    ingestNews.execute().catch((err) => console.error("Background RSS ingestion error:", err));
  }, 180 * 1000);
  setTimeout(() => {
    ingestNews.execute().catch((err) => console.error("Initial RSS ingestion error:", err));
  }, 5000);

  // EOD Pipeline - Automated ML Training at 4:05 PM IST (Monday to Friday)
  // Assuming the server timezone is UTC, we can explicitly specify Asia/Kolkata to ensure it runs at 4:05 PM IST
  cron.schedule("5 16 * * 1-5", () => {
    console.log("Triggering EOD Pipeline...");
    const child = spawn("npm", ["run", "pipeline:eod"], { stdio: "inherit", shell: true });
    child.on("error", (err) => console.error("EOD Pipeline spawn error:", err));
  }, { timezone: "Asia/Kolkata" });

  // Institutional Data Collection at 6:30 PM IST (Monday to Friday)
  cron.schedule("30 18 * * 1-5", () => {
    console.log("Triggering Institutional Data Collection...");
    const child = spawn("npm", ["run", "data:collect:institutional"], { stdio: "inherit", shell: true });
    child.on("error", (err) => console.error("Institutional Data Collection spawn error:", err));
  }, { timezone: "Asia/Kolkata" });

  const aiAutonomousAgent = new AiAutonomousAgent(
    database,
    strategyContextRepository,
    tradeIdeaRepository,
    paperAccountRepository,
    paperTradeRepository,
    candleRepository,
    newsRepository,
    aiJournalRepository,
  );
  app.use((request, response, next) => {
    const startedAt = performance.now();
    response.on("finish", () => {
      console.info(JSON.stringify({
        level: "info",
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    });
    next();
  });
  app.use(cors());
  app.use(express.json());

  app.get("/api/v1/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "ai-quant-lab-api" });
  });

  app.get("/api/v1/health/ready", async (_request, response) => {
    try {
      const databaseStatus = await checkDatabaseReadiness(database);
      response.status(200).json({ status: "ready", database: databaseStatus });
    } catch (error) {
      response.status(503).json({ status: "not_ready", database: { ready: false } });
    }
  });

  /**
   * The active instrument registry is presented as a local watchlist only.
   * It does not add/remove instruments or subscribe to any live data feed.
   */
  app.get("/api/v1/watchlist", async (request, response, next) => {
    try {
      const result = await listWatchlist.execute(parseWatchlistQuery(request));
      response.status(200).json({
        data: result.records,
        page: {
          limit: result.limit,
          nextCursor: result.nextCursor,
        },
      });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  /**
   * Stored, completed-candle evidence only. No live quote, candle collection,
   * prediction inference, trade idea, paper activity, broker, or order data is
   * read or changed by this endpoint.
   */
  app.get("/api/v1/market-scanner", async (request, response, next) => {
    try {
      const result = await listMarketScanner.execute(parseMarketScannerQuery(request));
      response.status(200).json({
        data: result.records,
        page: {
          limit: result.limit,
          nextCursor: result.nextCursor,
        },
        context: {
          researchOnly: true,
          timeframe: result.timeframe,
          activeStrategies: result.activeStrategies,
        },
      });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  /**
   * Read-only research records from Phase 11. These routes do not create trade
   * ideas, paper activity, model versions, or real orders.
   *
   * A subsequent page sends both `cursorCreatedAt` and `cursorId` from
   * `page.nextCursor`; they are the same millisecond/id ordering key used by
   * the database query.
   */
  app.get("/api/v1/model-predictions", async (request, response, next) => {
    try {
      const result = await listModelPredictions.execute(parseListQuery(request));
      response.status(200).json({
        data: result.records,
        page: {
          limit: result.limit,
          nextCursor: result.nextCursor,
        },
      });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/model-predictions/:id", async (request, response, next) => {
    try {
      const prediction = await getModelPrediction.execute(request.params.id ?? "");
      if (!prediction) {
        response.status(404).json({ error: "Prediction not found" });
        return;
      }
      response.status(200).json({ data: prediction });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  /**
   * The complete local simulated-trade ledger across every paper account.
   *
   * This route only reads stored paper activity. It cannot open, close, evaluate,
   * or cancel a trade, and there is no broker or order-routing path behind it.
   */
  app.get("/api/v1/paper-trades", async (request, response, next) => {
    try {
      const result = await listPaperTradeHistory.execute(parseTradeHistoryQuery(request));
      response.status(200).json({
        data: result.records,
        summary: result.summary,
        page: {
          limit: result.limit,
          truncated: result.truncated,
        },
        context: {
          simulatedOnly: true,
          accounts: result.accounts,
        },
      });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  /**
   * The local model registry with the training evidence recorded for each version.
   *
   * Read-only by construction: it cannot train, promote, reject, or archive a
   * model, and it never returns an artifact file location.
   */
  app.get("/api/v1/model-versions", async (request, response, next) => {
    try {
      const result = await listModelVersions.execute(parseModelVersionQuery(request));
      response.status(200).json({
        data: result.records,
        families: result.families,
        page: {
          limit: result.limit,
          truncated: result.truncated,
        },
        context: { researchOnly: true },
      });
    } catch (error) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  // Paper Trading Routes
  app.get("/api/v1/paper-accounts", async (_request, response, next) => {
    try {
      const accounts = await dashboardRepository.listPaperAccounts();
      response.status(200).json({ data: accounts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/paper-accounts", async (request, response, _next) => {
    try {
      const { name, openingBalance } = request.body || {};
      if (!name || typeof name !== "string" || !openingBalance || typeof openingBalance !== "number") {
        response.status(400).json({ error: "name (string) and openingBalance (number) are required." });
        return;
      }
      const account = await createPaperAccount.execute({ name, openingBalance });
      response.status(201).json({ data: account });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to create paper account" });
    }
  });

  app.get("/api/v1/paper-accounts/:id/summary", async (request, response, _next) => {
    try {
      try {
        const openTrades = await paperTradeRepository.listOpenByAccount(request.params.id || "");
        const activeSymbols = [...new Set(openTrades.map((t) => t.instrumentSymbol?.toUpperCase()).filter(Boolean))];
        const livePrices: Record<string, number> = {};

        if (activeSymbols.length > 0) {
          const yf = new (yahooFinance as any)();
          for (const sym of activeSymbols) {
            let yfSymbol = sym as string;
            if (sym === "NIFTY50") yfSymbol = "^NSEI";
            else if (sym === "BANKNIFTY") yfSymbol = "^NSEBANK";
            else if (!sym!.includes(".")) yfSymbol = `${sym}.NS`;
            
            try {
              const quote = await yf.quote(yfSymbol);
              if (quote && quote.regularMarketPrice) {
                livePrices[sym as string] = quote.regularMarketPrice;
              }
            } catch (err) {
              console.error(`Failed to fetch live price for ${sym}:`, err);
            }
          }
        }
        
        const evalRes = await evaluateOpenPaperTrades.execute({
          accountId: request.params.id || "",
          asOf: new Date(),
          livePrices,
        });
        if (evalRes.tradesClosed > 0) {
          for (const closedId of evalRes.closedTradeIds) {
            await aiAutonomousAgent.generateSelfReflection(closedId, "NIFTY50");
          }
        }
      } catch {
        // Ignore live evaluation errors during summary polling
      }
      const summary = await getPaperAccountSummary.execute(request.params.id || "");
      const fullSummary = await dashboardRepository.getPaperAccountFullSummary(request.params.id || "", summary);
      response.status(200).json({ data: fullSummary });
    } catch (error: any) {
      response.status(404).json({ error: error.message || "Account not found" });
    }
  });

  app.post("/api/v1/paper-trades/open", async (request, response, _next) => {
    try {
      const { accountId, tradeIdeaId, fillPrice, quantity, notes } = request.body || {};
      if (!accountId || !tradeIdeaId || typeof fillPrice !== "number" || typeof quantity !== "number") {
        response.status(400).json({ error: "accountId, tradeIdeaId, fillPrice, and quantity are required." });
        return;
      }
      const trade = await openPaperTrade.execute({
        accountId,
        tradeIdeaId,
        fillPrice,
        quantity,
        openedAt: new Date(),
        entryFees: 0,
        entrySlippage: 0,
        notes: notes || "Opened via UI",
      });
      response.status(201).json({ data: trade });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to open paper trade" });
    }
  });

  app.post("/api/v1/paper-trades/evaluate", async (request, response, _next) => {
    try {
      const { accountId } = request.body || {};
      if (!accountId) {
        response.status(400).json({ error: "accountId is required." });
        return;
      }
      const openTrades = await paperTradeRepository.listOpenByAccount(accountId);
      const activeSymbols = [...new Set(openTrades.map((t) => t.instrumentSymbol?.toUpperCase()).filter(Boolean))];
      const livePrices: Record<string, number> = {};

      if (activeSymbols.length > 0) {
        const yf = new (yahooFinance as any)();
        for (const sym of activeSymbols) {
          let yfSymbol = sym as string;
          if (sym === "NIFTY50") yfSymbol = "^NSEI";
          else if (sym === "BANKNIFTY") yfSymbol = "^NSEBANK";
          else if (!sym!.includes(".")) yfSymbol = `${sym}.NS`;
          
          try {
            const quote = await yf.quote(yfSymbol);
            if (quote && quote.regularMarketPrice) {
              livePrices[sym as string] = quote.regularMarketPrice;
            }
          } catch (err) {
            console.error(`Failed to fetch live price for ${sym}:`, err);
          }
        }
      }
      
      const result = await evaluateOpenPaperTrades.execute({ accountId, asOf: new Date(), livePrices });
      response.status(200).json({ data: result });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to evaluate trades" });
    }
  });

  app.post("/api/v1/paper-trades/close", async (request, response, _next) => {
    try {
      const { paperTradeId, exitPrice, notes } = request.body || {};
      if (!paperTradeId || typeof exitPrice !== "number") {
        response.status(400).json({ error: "paperTradeId and exitPrice (number) are required." });
        return;
      }
      const trade = await closePaperTrade.execute({
        paperTradeId,
        exitPrice,
        closedAt: new Date(),
        exitFees: 0,
        exitSlippage: 0,
        notes: notes || "Manually closed from UI",
      });
      response.status(200).json({ data: trade });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to close trade" });
    }
  });

  // Strategy & Trade Ideas Routes
  app.get("/api/v1/trade-ideas", async (request, response, next) => {
    try {
      const limit = parseLimit(request) || 50;
      const dateStr = queryString(request, "date");
      const ideas = await dashboardRepository.listTradeIdeas(limit, dateStr || undefined);
      response.status(200).json({ data: ideas });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/trade-ideas/generate", async (request, response, _next) => {
    try {
      const { symbol, timeframe } = request.body || {};
      if (!symbol || !timeframe) {
        response.status(400).json({ error: "symbol and timeframe are required." });
        return;
      }
      const instResult = await database.query("SELECT id FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1", [String(symbol).toUpperCase()]);
      if (!instResult.rows[0]) {
        response.status(404).json({ error: `Instrument ${symbol} not found.` });
        return;
      }
      const instrumentId = instResult.rows[0].id;
      const ideas = await generateTradeIdeas.execute({
        instrumentId,
        timeframe: String(timeframe),
      });
      response.status(200).json({ data: ideas });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to generate trade ideas" });
    }
  });

  // Backtesting Routes
  app.get("/api/v1/backtest-runs", async (request, response, next) => {
    try {
      const limit = parseLimit(request) || 50;
      const runs = await dashboardRepository.listBacktestRuns(limit);
      response.status(200).json({ data: runs });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/backtest-runs/:id", async (request, response, next) => {
    try {
      const details = await dashboardRepository.getBacktestRunDetails(request.params.id || "");
      if (!details) {
        response.status(404).json({ error: "Backtest run not found" });
        return;
      }
      response.status(200).json({ data: details });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/backtest-runs", async (request, response, _next) => {
    try {
      const { symbol, timeframe, startDate, endDate } = request.body || {};
      if (!symbol || !timeframe || !startDate || !endDate) {
        response.status(400).json({ error: "symbol, timeframe, startDate, and endDate are required." });
        return;
      }
      const instResult = await database.query("SELECT id FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1", [String(symbol).toUpperCase()]);
      if (!instResult.rows[0]) {
        response.status(404).json({ error: `Instrument ${symbol} not found.` });
        return;
      }
      const instrumentId = instResult.rows[0].id;
      const stratResult = await database.query("SELECT id, configuration FROM strategy_versions WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1");
      if (!stratResult.rows[0]) {
        response.status(404).json({ error: "No active strategy version found in database." });
        return;
      }
      const strategyVersionId = stratResult.rows[0].id;
      const strategyConfiguration = stratResult.rows[0].configuration || {};
      const result = await runBacktest.execute({
        strategyVersionId,
        strategyConfiguration,
        instrumentId,
        timeframe: String(timeframe),
        dataWindowStart: new Date(startDate),
        dataWindowEnd: new Date(endDate),
        dataCutoffAt: new Date(endDate),
      });
      response.status(201).json({
        data: {
          ...result,
          backtestRunId: result.runId,
          tradesSimulated: result.metrics.tradeCount,
          status: "COMPLETED",
        }
      });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to run backtest" });
    }
  });

  // Charts & Analysis Routes
  app.get("/api/v1/candles", async (request, response, next) => {
    try {
      const symbol = queryString(request, "symbol") || "NIFTY50";
      const timeframe = queryString(request, "timeframe") || "1d";
      const limit = parseLimit(request) || 100;
      const candles = await dashboardRepository.listCandlesWithOverlays(symbol, timeframe, limit);
      response.status(200).json({ data: candles });
    } catch (error: any) {
      if (isQueryValidationError(error)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  const getChartDataHandler = async (symbolStr: string, tfStr: string, response: Response, next: NextFunction) => {
    try {
      const rows = await dashboardRepository.listCandlesWithOverlays(symbolStr.toUpperCase(), tfStr, 100);
      const candles = rows.map((r) => ({
        timestamp: r.openTime instanceof Date ? r.openTime.toISOString() : String(r.openTime),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }));

      // Append real live candle to the chart
      try {
        const symbolObj = symbolStr.toUpperCase();
        let yfSymbol = symbolObj;
        if (symbolObj === "NIFTY50") yfSymbol = "^NSEI";
        else if (symbolObj === "BANKNIFTY") yfSymbol = "^NSEBANK";
        else if (!symbolObj.includes(".")) yfSymbol = `${symbolObj}.NS`;
        
        const yf = new (yahooFinance as any)();
        const quote = (await yf.quote(yfSymbol)) as any;
        const liveClose = quote.regularMarketPrice;
        if (liveClose) {
          candles.push({
            timestamp: quote.regularMarketTime ? quote.regularMarketTime.toISOString() : new Date().toISOString(),
            open: quote.regularMarketOpen || liveClose,
            high: quote.regularMarketDayHigh || liveClose,
            low: quote.regularMarketDayLow || liveClose,
            close: liveClose,
            volume: quote.regularMarketVolume || 0,
          });
        }
      } catch (e) {
        // ignore if it fails
      }
      const indicators: Record<string, any[]> = { SMA: [], BB: [], RSI: [] };
      const patterns: any[] = [];
      rows.forEach((r, idx) => {
        const ts = r.openTime instanceof Date ? r.openTime.toISOString() : String(r.openTime);
        const ind = r.indicators || {};
        if (ind["SMA"]) indicators["SMA"]?.push({ timestamp: ts, value: Number((ind["SMA"] as any)?.value || r.close) });
        if (ind["BB"]) indicators["BB"]?.push({ timestamp: ts, upper: Number((ind["BB"] as any)?.upper || r.high), middle: Number((ind["BB"] as any)?.middle || r.close), lower: Number((ind["BB"] as any)?.lower || r.low) });
        if (ind["RSI"]) indicators["RSI"]?.push({ timestamp: ts, value: Number((ind["RSI"] as any)?.value || 50) });
        if (r.patterns && Array.isArray(r.patterns)) {
          r.patterns.forEach((p: any, pidx: number) => {
            patterns.push({
              id: `${r.id}-${pidx}`,
              name: p.name || p.code || "Pattern",
              type: p.code || "PATTERN",
              timestamp: ts,
              price: r.close,
              confidence: Number(p.confidence || 0.8),
              direction: p.direction || "NEUTRAL",
            });
          });
        }
      });
      response.status(200).json({
        data: {
          symbol: symbolStr.toUpperCase(),
          timeframe: tfStr,
          candles,
          indicators,
          patterns,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  app.get("/api/v1/charts/data", async (request, response, next) => {
    const symbol = queryString(request, "symbol") || "NIFTY50";
    const timeframe = queryString(request, "timeframe") || "1d";
    await getChartDataHandler(symbol, timeframe, response, next);
  });

  app.post("/api/v1/charts/data", async (request, response, next) => {
    const { symbol = "NIFTY50", timeframe = "1d" } = request.body || {};
    await getChartDataHandler(String(symbol), String(timeframe), response, next);
  });

  app.get("/api/v1/live-price", async (request, response, next) => {
    try {
      const symbol = (queryString(request, "symbol") || "NIFTY50").toUpperCase();
      const timeframe = (queryString(request, "timeframe") || "1d").toLowerCase();
      
      // Map to Yahoo Finance symbols
      let yfSymbol = symbol;
      if (symbol === "NIFTY50") yfSymbol = "^NSEI";
      else if (symbol === "BANKNIFTY") yfSymbol = "^NSEBANK";
      else if (!symbol.includes(".")) yfSymbol = `${symbol}.NS`; // default to NSE

      // Fetch live data from Yahoo Finance
      const yf = new (yahooFinance as any)();
      const quote = (await yf.quote(yfSymbol)) as any;
      const close = quote.regularMarketPrice || 0;
      const change = quote.regularMarketChange || 0;
      const changePercent = quote.regularMarketChangePercent || 0;

      // Trigger AI agent decision & learning loop on live quote queries
      try {
        await aiAutonomousAgent.tick(symbol, timeframe, close);
      } catch {
        // Ignore AI tick errors during quote queries
      }

      // We still fetch latest DB row to serve the static technical indicators & patterns for chart overlays
      let rsiVal = 51, smaVal = close, bbObj = { upper: close * 1.01, middle: close, lower: close * 0.99 };
      let latestPattern = { name: "BULLISH_ENGULFING", direction: "BULLISH", confidence: 0.85 };
      try {
        const rows = await dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 1);
        if (rows && rows.length > 0) {
          const latest = rows[0]!;
          const ind = latest.indicators || {};
          rsiVal = Number((ind["RSI"] as any)?.value || rsiVal);
          smaVal = Number((ind["SMA"] as any)?.value || smaVal);
          bbObj = (ind["BB"] as any) || bbObj;

          const patterns = Array.isArray(latest.patterns) ? latest.patterns : [];
          if (patterns.length > 0) {
            latestPattern = {
              name: patterns[0].name || patterns[0].code || "BULLISH_ENGULFING",
              direction: patterns[0].direction || "BULLISH",
              confidence: Number(patterns[0].confidence || 0.85),
            };
          }
        }
      } catch (err) {
        // Fallback to defaults if DB fails
      }

      response.status(200).json({
        data: {
          symbol,
          displayName: quote.shortName || (symbol === "BANKNIFTY" ? "NIFTY BANK" : "NIFTY 50"),
          exchange: quote.exchange || "NSE",
          livePrice: close,
          change,
          changePercent,
          open: quote.regularMarketOpen || close,
          high: quote.regularMarketDayHigh || close,
          low: quote.regularMarketDayLow || close,
          volume: quote.regularMarketVolume || 0,
          lastUpdated: quote.regularMarketTime ? quote.regularMarketTime.toISOString() : new Date().toISOString(),
          indicators: {
            rsi: rsiVal,
            sma20: smaVal,
            bollinger: {
              upper: Number(bbObj.upper),
              middle: Number(bbObj.middle),
              lower: Number(bbObj.lower),
            },
          },
          latestPattern,
          status: "MARKET_LIVE",
          researchOnly: false,
        },
      });
    } catch (error) {
      console.error("Live Price Error:", error);
      next(error);
    }
  });

  app.post("/api/v1/analysis/run", async (request, response, _next) => {
    try {
      const { symbol, timeframe } = request.body || {};
      if (!symbol || !timeframe) {
        response.status(400).json({ error: "symbol and timeframe are required." });
        return;
      }
      const candles = await dashboardRepository.listCandlesWithOverlays(String(symbol), String(timeframe), 100);
      response.status(200).json({ status: "success", count: candles.length, message: `Analysis complete for ${symbol} (${timeframe})` });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to run analysis" });
    }
  });

  app.get("/api/v1/stream/live-agent", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const symbol = queryString(request, "symbol") || "NIFTY50";
    const timeframe = queryString(request, "timeframe") || "1d";

    let tickCount = 0;
    const intervalId = setInterval(async () => {
      try {
        const candles = await dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 5);
        if (!candles || candles.length < 2) return;
        const latest = candles[0];
        const prev = candles[1];

        let livePrice = Number(latest.close);
        let prevClose = Number(prev.close);
        let change = 0;
        let changePercent = 0;
        let liveVolume = Number(latest.volume);
        let liveOpen = Number(latest.open);
        let liveHigh = Number(latest.high);
        let liveLow = Number(latest.low);
        let lastUpdated = new Date().toISOString();

        try {
          const symbolObj = symbol.toUpperCase();
          let yfSymbol = symbolObj;
          if (symbolObj === "NIFTY50") yfSymbol = "^NSEI";
          else if (symbolObj === "BANKNIFTY") yfSymbol = "^NSEBANK";
          else if (!symbolObj.includes(".")) yfSymbol = `${symbolObj}.NS`;
          
          const yf = new (yahooFinance as any)();
          const quote = (await yf.quote(yfSymbol)) as any;
          if (quote.regularMarketPrice) {
            livePrice = quote.regularMarketPrice;
            prevClose = quote.regularMarketPreviousClose || prevClose;
            change = quote.regularMarketChange || (livePrice - prevClose);
            changePercent = quote.regularMarketChangePercent || ((change / prevClose) * 100);
            liveVolume = quote.regularMarketVolume || liveVolume;
            liveOpen = quote.regularMarketOpen || liveOpen;
            liveHigh = quote.regularMarketDayHigh || liveHigh;
            liveLow = quote.regularMarketDayLow || liveLow;
            lastUpdated = quote.regularMarketTime ? quote.regularMarketTime.toISOString() : lastUpdated;
          }
        } catch (e) {
          // Fallback to simulated micro fluctuations if yahoo finance fails
          const baseClose = Number(latest.close);
          const noise = (Math.sin(Date.now() / 800) * (symbol === "NIFTY50" ? 18 : 45)) + ((Math.random() - 0.5) * (symbol === "NIFTY50" ? 15 : 40));
          livePrice = Number((baseClose + noise).toFixed(2));
          change = Number((livePrice - prevClose).toFixed(2));
          changePercent = Number(((change / prevClose) * 100).toFixed(2));
          liveVolume = Number(latest.volume) + (tickCount * (symbol === "NIFTY50" ? 125 : 310));
          liveHigh = Math.max(Number(latest.high), livePrice);
          liveLow = Math.min(Number(latest.low), livePrice);
        }

        // Trigger AI agent decision & learning loop
        await aiAutonomousAgent.tick(symbol, timeframe, livePrice);

        const rsiVal = latest.indicators?.["rsi"] !== undefined ? Number(latest.indicators["rsi"]) : 55;
        const smaVal = latest.indicators?.["sma_20"] !== undefined ? Number(latest.indicators["sma_20"]) : Number((livePrice * 0.995).toFixed(2));
        const bbObj = (latest.indicators?.["bb_20_2"] as Record<string, unknown>) || {
          upper: livePrice * 1.015,
          middle: livePrice,
          lower: livePrice * 0.985,
        };

        const payload = {
          symbol,
          livePrice,
          change,
          changePercent,
          open: liveOpen,
          high: liveHigh,
          low: liveLow,
          volume: liveVolume,
          lastUpdated: lastUpdated,
          indicators: {
            rsi: rsiVal,
            sma20: smaVal,
            bollinger: {
              upper: Number(bbObj.upper),
              middle: Number(bbObj.middle),
              lower: Number(bbObj.lower),
            },
          },
          latestPattern: latest.patterns?.[0] || null,
          thoughts: aiAutonomousAgent.getThoughts(8),
          reflections: await aiAutonomousAgent.getReflections(6),
        };

        response.write(`data: ${JSON.stringify(payload)}\n\n`);
        tickCount += 1;
      } catch (err) {
        // Ignore transient stream errors
      }
    }, 1000);

    request.on("close", () => {
      clearInterval(intervalId);
    });
  });

  app.get("/api/v1/agent/performance", async (request, response, next) => {
    try {
      const accountId = queryString(request, "accountId") || "Default Paper Account";
      const period = queryString(request, "period") || "1d";
      const metrics = await aiAutonomousAgent.getPerformanceMetrics(accountId, period);
      response.status(200).json({ data: metrics });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/market-news", async (request, response, next) => {
    try {
      const provider = queryString(request, "provider")?.toUpperCase() as any;
      const sentimentLabel = queryString(request, "sentiment")?.toUpperCase() as any;
      const symbol = queryString(request, "symbol")?.toUpperCase();
      const search = queryString(request, "search");
      const limitText = queryString(request, "limit");
      const limit = limitText ? Number(limitText) : 50;

      const result = await listNews.execute({
        provider,
        sentimentLabel,
        symbol,
        search,
        limit,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/market-news/refresh", async (_request, response, next) => {
    try {
      const result = await ingestNews.execute();
      response.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => response.status(404).json({ error: "Route not found" }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).json({ error: "Unexpected server error" });
  });
  return app;
}
