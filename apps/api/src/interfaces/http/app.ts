import cors from "cors";
import express, { type Express } from "express";
import type { DatabaseQueryable } from "../../infrastructure/database/database.js";
import { registerBacktestingRoutes } from "../../modules/backtesting/interfaces/http/backtesting.routes.js";
import { registerMarketDataRoutes } from "../../modules/market-data/interfaces/http/market-data.routes.js";
import { registerMarketScannerRoutes } from "../../modules/market-scanner/interfaces/http/market-scanner.routes.js";
import { registerModelPerformanceRoutes } from "../../modules/model-performance/interfaces/http/model-performance.routes.js";
import { registerModelPredictionRoutes } from "../../modules/model-predictions/interfaces/http/model-prediction.routes.js";
import { registerNewsRoutes } from "../../modules/news-sentiment/interfaces/http/news.routes.js";
import { registerPaperTradingRoutes } from "../../modules/paper-trading/interfaces/http/paper-trading.routes.js";
import { registerPricingRoutes } from "../../modules/pricing/interfaces/http/pricing.routes.js";
import { registerStrategyRoutes } from "../../modules/strategy-engine/interfaces/http/strategy.routes.js";
import {
  createMutationRateLimiter,
  errorHandler,
  notFoundHandler,
  requestLogger,
  securityHeaders,
} from "./common/middleware.js";
import { buildHttpDependencies } from "./dependencies.js";
import { registerHealthRoutes } from "./routes/health.routes.js";

export interface ApplicationDependencies {
  database: DatabaseQueryable;
}

/**
 * HTTP composition root.
 *
 * Feature modules own their routes and controller logic. This function only
 * creates shared dependencies, installs middleware in order, registers the
 * modules, and terminates the pipeline with the common 404/error handlers.
 */
export function createApp({ database }: ApplicationDependencies): Express {
  const app = express();
  const dependencies = buildHttpDependencies(database);
  const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const configuredMutationLimit = Number(process.env.API_MUTATION_RATE_LIMIT ?? "120");
  const mutationLimit = Number.isInteger(configuredMutationLimit) && configuredMutationLimit > 0
    ? configuredMutationLimit
    : 120;

  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(cors({
    origin(origin, callback) {
      if (origin === undefined || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed by CORS policy."));
    },
  }));
  app.use(express.json({ limit: "256kb" }));
  app.use(createMutationRateLimiter({ maxRequests: mutationLimit, windowMs: 60_000 }));

  registerHealthRoutes(app, dependencies);
  registerMarketScannerRoutes(app, dependencies);
  registerModelPredictionRoutes(app, dependencies);
  registerPaperTradingRoutes(app, dependencies);
  registerModelPerformanceRoutes(app, dependencies);
  registerPricingRoutes(app, dependencies);
  registerStrategyRoutes(app, dependencies);
  registerBacktestingRoutes(app, dependencies);
  registerMarketDataRoutes(app, dependencies);
  registerNewsRoutes(app, dependencies);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
