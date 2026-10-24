import cors from "cors";
import express, { type Express } from "express";
import { loadHttpConfiguration, type HttpConfiguration } from "../../config/environment.js";
import type { DatabaseQueryable } from "../../infrastructure/database/database.js";
import { registerBacktestingRoutes } from "../../modules/backtesting/interfaces/http/backtesting.routes.js";
import { registerMarketDataRoutes } from "../../modules/market-data/interfaces/http/market-data.routes.js";
import { registerDepthRoutes } from "../../modules/market-data/interfaces/http/depth.routes.js";
import { registerVolumeProfileRoutes } from "../../modules/market-data/interfaces/http/volume-profile.routes.js";
import { registerRealizedMovesRoutes } from "../../modules/market-data/interfaces/http/realized-moves.routes.js";
import { registerDataCoverageRoutes } from "../../modules/market-data/interfaces/http/data-coverage.routes.js";
import { registerSessionSnapshotsRoutes } from "../../modules/market-data/interfaces/http/session-snapshots.routes.js";
import { registerQuoteStalenessRoutes } from "../../modules/market-data/interfaces/http/quote-staleness.routes.js";
import { registerDevelopingValueRoutes } from "../../modules/market-data/interfaces/http/developing-value.routes.js";
import { registerVolumeByTimeRoutes } from "../../modules/market-data/interfaces/http/volume-by-time.routes.js";
import { registerMarketScannerRoutes } from "../../modules/market-scanner/interfaces/http/market-scanner.routes.js";
import { registerModelPerformanceRoutes } from "../../modules/model-performance/interfaces/http/model-performance.routes.js";
import { registerModelPredictionRoutes } from "../../modules/model-predictions/interfaces/http/model-prediction.routes.js";
import { registerNewsRoutes } from "../../modules/news-sentiment/interfaces/http/news.routes.js";
import { registerEquityRoutes } from "../../modules/equity-research/interfaces/http/equity.routes.js";
import { registerPaperTradingRoutes } from "../../modules/paper-trading/interfaces/http/paper-trading.routes.js";
import { registerJournalRoutes } from "../../modules/paper-trading/interfaces/http/journal.routes.js";
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
import { registerFyersAuthRoutes } from "./routes/fyers-auth.routes.js";
import { registerHealthRoutes } from "./routes/health.routes.js";

export interface ApplicationDependencies {
  database: DatabaseQueryable;
  /**
   * Validated configuration. Optional so existing callers -- notably the route tests, which
   * construct an app around a stub database -- keep working without one; when absent the
   * schema's own defaults are used, which is the same answer the inline parsing produced.
   */
  environment?: HttpConfiguration;
}

/**
 * HTTP composition root.
 *
 * Feature modules own their routes and controller logic. This function only
 * creates shared dependencies, installs middleware in order, registers the
 * modules, and terminates the pipeline with the common 404/error handlers.
 */
export function createApp({ database, environment }: ApplicationDependencies): Express {
  const app = express();
  const dependencies = buildHttpDependencies(database, { streamQuotes: true });
  // Origins and the mutation limit are parsed and defaulted by the schema in `config/`, not
  // here. This function used to split the raw string and coerce the number itself, so the
  // effective default and the documented one in `.env.example` could drift with nothing to
  // compare -- and an unparseable limit fell back to 120 without saying so.
  const configuration = environment ?? loadHttpConfiguration();
  const allowedOrigins = new Set(configuration.CORS_ORIGINS);
  const mutationLimit = configuration.API_MUTATION_RATE_LIMIT;

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
  registerFyersAuthRoutes(app, dependencies, configuration);
  registerMarketScannerRoutes(app, dependencies);
  registerModelPredictionRoutes(app, dependencies);
  registerPaperTradingRoutes(app, dependencies);
  registerJournalRoutes(app, dependencies);
  registerModelPerformanceRoutes(app, dependencies);
  registerPricingRoutes(app, dependencies);
  registerStrategyRoutes(app, dependencies);
  registerBacktestingRoutes(app, dependencies);
  registerMarketDataRoutes(app, dependencies);
  registerDepthRoutes(app, dependencies);
  registerVolumeProfileRoutes(app, dependencies);
  registerVolumeByTimeRoutes(app, dependencies);
  registerDevelopingValueRoutes(app, dependencies);
  registerDataCoverageRoutes(app, dependencies);
  registerQuoteStalenessRoutes(app, dependencies);
  registerSessionSnapshotsRoutes(app, dependencies);
  registerRealizedMovesRoutes(app, dependencies);
  registerNewsRoutes(app, dependencies);
  registerEquityRoutes(app, database);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
