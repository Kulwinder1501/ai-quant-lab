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
import { PostgresEquityAlertRepository } from "../../infrastructure/repositories/postgres-equity-alert-repository.js";
import {
  PostgresEquityEventFlagRepository,
  EventAlreadySupersededError,
} from "../../infrastructure/repositories/postgres-equity-event-flag-repository.js";
import { MANUAL_EVENT_KINDS } from "../../domain/types.js";
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

const alertQuerySchema = z.object({
  stockId: z.string().uuid("Invalid stock ID format").optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  status: z.enum(["NEW", "SEEN", "DISMISSED"], {
    errorMap: () => ({ message: "Status must be 'NEW', 'SEEN', or 'DISMISSED'" }),
  }).optional(),
  kind: z.enum([
    "LEVEL_APPROACH",
    "LEVEL_ZONE_ENTER",
    "LEVEL_BREAK",
    "NEW_52W_EXTREME",
    "LARGE_MOVE",
    "DATA_EVENT",
    "DATA_HEALTH",
  ], {
    errorMap: () => ({ message: "Invalid alert kind" }),
  }).optional(),
  severity: z.enum(["INFO", "NOTICE"], {
    errorMap: () => ({ message: "Severity must be 'INFO' or 'NOTICE'" }),
  }).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "From date must be YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "To date must be YYYY-MM-DD").optional(),
  evaluatedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Evaluated date must be YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const alertIdParamSchema = z.object({
  id: z.string().uuid("Alert ID must be a valid UUID"),
});

const updateAlertStatusSchema = z.object({
  status: z.enum(["NEW", "SEEN", "DISMISSED"], {
    errorMap: () => ({ message: "Status must be 'NEW', 'SEEN', or 'DISMISSED'" }),
  }).optional(),
  state: z.enum(["NEW", "SEEN", "DISMISSED"]).optional(),
}).refine((data) => data.status !== undefined || data.state !== undefined, {
  message: "Status must be 'NEW', 'SEEN', or 'DISMISSED'",
});

const eventQuerySchema = z.object({
  stockId: z.string().uuid("Invalid stock ID format").optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  origin: z.enum(["DETECTED", "MANUAL"], {
    errorMap: () => ({ message: "Origin must be 'DETECTED' or 'MANUAL'" }),
  }).optional(),
  kind: z.string().trim().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "From date must be YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "To date must be YYYY-MM-DD").optional(),
  includeHistory: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createManualEventSchema = z.object({
  stockId: z.string().uuid("Stock ID must be a valid UUID"),
  kind: z.enum(MANUAL_EVENT_KINDS, {
    errorMap: () => ({
      message: `Invalid event kind. Manual events must be one of: ${MANUAL_EVENT_KINDS.join(", ")}`,
    }),
  }),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be YYYY-MM-DD"),
  headline: z.string().trim().min(1, "Headline is required").max(200, "Headline must be at most 200 characters"),
  sourceUrl: z
    .string({
      required_error: "Source URL is required for manual events (Gate E8)",
      invalid_type_error: "Source URL must be a string",
    })
    .trim()
    .refine((url) => url.length > 8 && /^https:\/\/.+/i.test(url), {
      message: "Manual event requires a valid https source link (Gate E8)",
    }),
  detail: z.record(z.unknown()).optional(),
});

const eventIdParamSchema = z.object({
  id: z.string().uuid("Event ID must be a valid UUID"),
});

const editEventSchema = z.object({
  headline: z.string().trim().min(1).max(200).optional(),
  sourceUrl: z
    .string()
    .trim()
    .refine((url) => url.length > 8 && /^https:\/\/.+/i.test(url), {
      message: "Manual event requires a valid https source link (Gate E8)",
    })
    .optional(),
  kind: z
    .enum(MANUAL_EVENT_KINDS, {
      errorMap: () => ({
        message: `Invalid event kind. Manual events must be one of: ${MANUAL_EVENT_KINDS.join(", ")}`,
      }),
    })
    .optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be YYYY-MM-DD").optional(),
  detail: z.record(z.unknown()).optional(),
});

export interface EquityRouterOptions {
  alertRepo?: PostgresEquityAlertRepository;
  eventFlagRepo?: PostgresEquityEventFlagRepository;
  watchlistRepo?: PostgresEquityWatchlistRepository;
}

export function createEquityRouter(
  service: EquityWatchlistService,
  alertRepoOrOptions?: PostgresEquityAlertRepository | EquityRouterOptions,
  eventFlagRepoArg?: PostgresEquityEventFlagRepository,
  watchlistRepoArg?: PostgresEquityWatchlistRepository,
): Router {
  let alertRepo: PostgresEquityAlertRepository | undefined;
  let eventFlagRepo: PostgresEquityEventFlagRepository | undefined;
  let watchlistRepo: PostgresEquityWatchlistRepository | undefined;

  if (alertRepoOrOptions && "getAlerts" in alertRepoOrOptions) {
    alertRepo = alertRepoOrOptions;
    eventFlagRepo = eventFlagRepoArg;
    watchlistRepo = watchlistRepoArg;
  } else if (alertRepoOrOptions) {
    alertRepo = alertRepoOrOptions.alertRepo;
    eventFlagRepo = alertRepoOrOptions.eventFlagRepo;
    watchlistRepo = alertRepoOrOptions.watchlistRepo;
  }
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

  // --- Alerts Endpoints (Step 3) ---
  if (alertRepo) {
    // GET /api/v1/equity/alerts
    router.get("/alerts", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedQuery = alertQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          res.status(400).json({
            error: "Invalid query parameters",
            details: parsedQuery.error.issues.map((i) => i.message),
          });
          return;
        }

        const alerts = await alertRepo.getAlerts(parsedQuery.data);
        res.json(alerts);
      } catch (err) {
        next(err);
      }
    });

    // PATCH /api/v1/equity/alerts/:id/state and PATCH /api/v1/equity/alerts/:id/status
    const handleUpdateAlertStatus = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedParams = alertIdParamSchema.safeParse(req.params);
        if (!parsedParams.success) {
          res.status(400).json({
            error: "Invalid alert ID",
            details: parsedParams.error.issues.map((i) => i.message),
          });
          return;
        }

        const parsedBody = updateAlertStatusSchema.safeParse(req.body);
        if (!parsedBody.success) {
          res.status(400).json({
            error: "Invalid alert status",
            details: parsedBody.error.issues.map((i) => i.message),
          });
          return;
        }

        const targetStatus = (parsedBody.data.status ?? parsedBody.data.state)!;
        const updated = await alertRepo.updateAlertState(parsedParams.data.id, targetStatus);
        if (!updated) {
          res.status(404).json({ error: `Alert '${parsedParams.data.id}' not found` });
          return;
        }

        res.json({
          success: true,
          alertId: parsedParams.data.id,
          status: targetStatus,
        });
      } catch (err) {
        next(err);
      }
    };

    router.patch("/alerts/:id/state", handleUpdateAlertStatus);
    router.patch("/alerts/:id/status", handleUpdateAlertStatus);
  }

  // --- Event Flags Endpoints (Step 3) ---
  if (eventFlagRepo) {
    // GET /api/v1/equity/events
    router.get("/events", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedQuery = eventQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          res.status(400).json({
            error: "Invalid query parameters",
            details: parsedQuery.error.issues.map((i) => i.message),
          });
          return;
        }

        const events = await eventFlagRepo.getEvents(parsedQuery.data);
        res.json(events);
      } catch (err) {
        next(err);
      }
    });

    // POST /api/v1/equity/events
    router.post("/events", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedBody = createManualEventSchema.safeParse(req.body);
        if (!parsedBody.success) {
          res.status(400).json({
            error: "Invalid event payload",
            details: parsedBody.error.issues.map((i) => i.message),
          });
          return;
        }

        if (watchlistRepo) {
          const stock = await watchlistRepo.findById(parsedBody.data.stockId);
          if (!stock) {
            res.status(404).json({ error: `Stock '${parsedBody.data.stockId}' not found in watchlist` });
            return;
          }
        }

        const created = await eventFlagRepo.saveManualEvent({
          stockId: parsedBody.data.stockId,
          kind: parsedBody.data.kind,
          eventDate: parsedBody.data.eventDate,
          headline: parsedBody.data.headline,
          sourceUrl: parsedBody.data.sourceUrl,
          detail: parsedBody.data.detail,
        });

        res.status(201).json(created);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Gate E8")) {
          res.status(400).json({ error: err.message });
        } else if (err instanceof Error && err.message.includes("foreign key")) {
          res.status(404).json({ error: "Stock not found in watchlist" });
        } else {
          next(err);
        }
      }
    });

    // PUT /api/v1/equity/events/:id and PATCH /api/v1/equity/events/:id (Gate E9 revision)
    const handleEditEvent = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedParams = eventIdParamSchema.safeParse(req.params);
        if (!parsedParams.success) {
          res.status(400).json({
            error: "Invalid event ID",
            details: parsedParams.error.issues.map((i) => i.message),
          });
          return;
        }

        const parsedBody = editEventSchema.safeParse(req.body);
        if (!parsedBody.success) {
          res.status(400).json({
            error: "Invalid event edit payload",
            details: parsedBody.error.issues.map((i) => i.message),
          });
          return;
        }

        const existing = await eventFlagRepo.getEventById(parsedParams.data.id);
        if (!existing) {
          res.status(404).json({ error: `Event '${parsedParams.data.id}' not found` });
          return;
        }

        // Fork protection: check if event has already been superseded
        const newer = await eventFlagRepo.getNewerRevision(existing.id);
        if (newer) {
          res.status(409).json({
            error: `Event has already been superseded by ${newer.id}`,
            newerRevisionId: newer.id,
            supersededBy: newer.id,
          });
          return;
        }

        const sourceUrl = parsedBody.data.sourceUrl ?? existing.source_url ?? "";
        if (!sourceUrl || !sourceUrl.toLowerCase().startsWith("https://") || sourceUrl.length <= 8) {
          res.status(400).json({ error: "Manual event requires a valid https source link (Gate E8)" });
          return;
        }

        // Gate E9: Immutability - edits create a new row pointing to existing.id via supersedes_id
        const revision = await eventFlagRepo.saveManualEvent({
          stockId: existing.stock_id,
          kind: parsedBody.data.kind ?? existing.kind,
          eventDate: parsedBody.data.eventDate ?? existing.event_date,
          headline: parsedBody.data.headline ?? existing.headline,
          sourceUrl,
          detail: parsedBody.data.detail ?? existing.detail_json,
          supersedesId: existing.id,
        });

        res.json(revision);
      } catch (err) {
        if (err instanceof EventAlreadySupersededError) {
          res.status(409).json({
            error: err.message,
            newerRevisionId: err.newerRevisionId,
            supersededBy: err.newerRevisionId,
          });
        } else if (err instanceof Error && err.message.includes("Gate E8")) {
          res.status(400).json({ error: err.message });
        } else {
          next(err);
        }
      }
    };

    router.put("/events/:id", handleEditEvent);
    router.patch("/events/:id", handleEditEvent);
  }

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
  const alertRepo = new PostgresEquityAlertRepository(database);
  const eventFlagRepo = new PostgresEquityEventFlagRepository(database);

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

  app.use("/api/v1/equity", createEquityRouter(service, { alertRepo, eventFlagRepo, watchlistRepo }));
}
