import { Router, type Request, type Response, type NextFunction, type Express } from "express";
import { z } from "zod";
import type { DatabaseQueryable } from "../../../../infrastructure/database/database.js";
import {
  EquityWatchlistService,
  InvalidSymbolError,
  WatchlistCapError,
  DuplicateStockError,
  StockNotFoundError,
  RateLimitedError,
  UpstreamDataError,
} from "../../application/equity-watchlist-service.js";
import { PostgresEquityWatchlistRepository } from "../../infrastructure/repositories/postgres-equity-watchlist-repository.js";
import { PostgresEquityPriceBarRepository } from "../../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquityCorporateActionRepository } from "../../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquitySecondaryFactRepository } from "../../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import { PostgresEquityRawRecordRepository } from "../../infrastructure/repositories/postgres-equity-raw-record-repository.js";
import { PostgresEquityQuoteCacheRepository } from "../../infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import { PostgresEquitySourceHealthRepository } from "../../infrastructure/repositories/postgres-equity-source-health-repository.js";
import { YahooClient } from "../../infrastructure/yahoo-client.js";

const addStockSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "Symbol is required")
    .max(20, "Symbol must be at most 20 characters"),
  exchange: z.enum(["NSE", "BSE"], {
    errorMap: () => ({ message: "Exchange must be 'NSE' or 'BSE'" }),
  }),
  note: z.string().trim().max(500, "Note must be at most 500 characters").optional(),
});

const detailQuerySchema = z.object({
  range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const stockIdParamSchema = z.object({
  id: z.string().uuid("Stock ID must be a valid UUID"),
});

export function createEquityRouter(service: EquityWatchlistService): Router {
  const router = Router();

  // GET /api/v1/equity/watchlist
  router.get("/watchlist", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await service.getWatchlist();
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/equity/watchlist
  router.post("/watchlist", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedBody = addStockSchema.safeParse(req.body);
      if (!parsedBody.success) {
        res.status(400).json({
          error: "Invalid request payload",
          details: parsedBody.error.issues.map((i) => i.message),
        });
        return;
      }

      const stock = await service.addStock(parsedBody.data);
      res.status(201).json(stock);
    } catch (err) {
      if (err instanceof InvalidSymbolError || err instanceof WatchlistCapError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof DuplicateStockError) {
        res.status(409).json({ error: err.message });
      } else if (err instanceof StockNotFoundError) {
        res.status(404).json({ error: err.message });
      } else if (err instanceof RateLimitedError) {
        res.status(429).json({ error: err.message });
      } else if (err instanceof UpstreamDataError) {
        res.status(502).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  // DELETE /api/v1/equity/watchlist/:id
  router.delete("/watchlist/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = stockIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        res.status(400).json({
          error: "Invalid stock ID",
          details: parsedParams.error.issues.map((i) => i.message),
        });
        return;
      }

      const result = await service.removeStock(parsedParams.data.id);
      res.json(result);
    } catch (err) {
      if (err instanceof StockNotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  // GET /api/v1/equity/watchlist/:id/detail
  router.get("/watchlist/:id/detail", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = stockIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        res.status(400).json({
          error: "Invalid stock ID",
          details: parsedParams.error.issues.map((i) => i.message),
        });
        return;
      }

      const parsedQuery = detailQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({
          error: "Invalid query parameters",
          details: parsedQuery.error.issues.map((i) => i.message),
        });
        return;
      }

      const detail = await service.getStockDetail(parsedParams.data.id, parsedQuery.data);
      res.json(detail);
    } catch (err) {
      if (err instanceof StockNotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  // GET /api/v1/equity/watchlist/:id/trend
  router.get("/watchlist/:id/trend", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = stockIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        res.status(400).json({
          error: "Invalid stock ID",
          details: parsedParams.error.issues.map((i) => i.message),
        });
        return;
      }

      const trend = await service.getTrend(parsedParams.data.id);
      res.json(trend);
    } catch (err) {
      if (err instanceof StockNotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  // GET /api/v1/equity/watchlist/:id/levels
  router.get("/watchlist/:id/levels", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = stockIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        res.status(400).json({
          error: "Invalid stock ID",
          details: parsedParams.error.issues.map((i) => i.message),
        });
        return;
      }

      const levels = await service.getLevels(parsedParams.data.id);
      res.json(levels);
    } catch (err) {
      if (err instanceof StockNotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  // GET /api/v1/equity/source-health
  router.get("/source-health", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await service.getSourceHealth();
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function registerEquityRoutes(app: Express, database: DatabaseQueryable): void {
  const watchlistRepo = new PostgresEquityWatchlistRepository(database);
  const priceBarRepo = new PostgresEquityPriceBarRepository(database);
  const corporateActionRepo = new PostgresEquityCorporateActionRepository(database);
  const secondaryFactRepo = new PostgresEquitySecondaryFactRepository(database);
  const rawRecordRepo = new PostgresEquityRawRecordRepository(database);
  const quoteCacheRepo = new PostgresEquityQuoteCacheRepository(database);
  const sourceHealthRepo = new PostgresEquitySourceHealthRepository(database);

  const yahooClient = new YahooClient({
    sourceHealthRepo,
  });

  const service = new EquityWatchlistService({
    watchlistRepo,
    priceBarRepo,
    corporateActionRepo,
    secondaryFactRepo,
    rawRecordRepo,
    quoteCacheRepo,
    sourceHealthRepo,
    yahooClient,
  });

  app.use("/api/v1/equity", createEquityRouter(service));
}
