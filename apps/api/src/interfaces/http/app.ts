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
import { errorHandler, notFoundHandler, requestLogger } from "./common/middleware.js";
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

  app.use(requestLogger);
  app.use(cors());
  app.use(express.json());

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
