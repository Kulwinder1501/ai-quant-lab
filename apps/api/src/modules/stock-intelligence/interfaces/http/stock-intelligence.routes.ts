import type { Express, NextFunction, Request, Response } from "express";
import { PostgresInstrumentRepository } from "../../../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStockIntelligenceStore } from "../../../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import type { ConsumerContext } from "../../domain/consumer-context.js";
import type { StockIntelligenceHorizon } from "../../domain/data-quality.js";
import { InstrumentResolveError } from "../../domain/identity.js";
import { GetStockOutlook } from "../../application/get-stock-outlook.js";
import { ResolveInstrument } from "../../application/resolve-instrument.js";

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next);
  };
}

export function registerStockIntelligenceRoutes(
  app: Express,
  { database }: Pick<HttpDependencies, "database">,
  enabled: boolean,
): void {
  if (!enabled) return;

  const store = new PostgresStockIntelligenceStore(database);
  const outlook = new GetStockOutlook(
    new ResolveInstrument(new PostgresInstrumentRepository(database), store),
    store,
  );

  app.get("/api/v1/stock-intelligence/outlook", asyncRoute(async (request, response) => {
    const query = String(request.query.query ?? request.query.symbol ?? "").trim();
    if (!query) {
      response.status(400).json({ error: "query is required." });
      return;
    }
    const horizon = String(request.query.horizon ?? "6M") as StockIntelligenceHorizon;
    const context = (String(request.query.context ?? "watchlist") === "holdings" ? "holdings" : "watchlist") as ConsumerContext;
    try {
      const body = await outlook.execute({ query, horizon, context });
      response.status(200).json(body);
    } catch (error) {
      if (error instanceof InstrumentResolveError) {
        response.status(404).json({ error: "Instrument was not resolved." });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/v1/stock-intelligence/holdings", asyncRoute(async (_request, response) => {
    response.status(200).json({ context: "holdings", items: await store.listHoldings() });
  }));

  app.get("/api/v1/stock-intelligence/watchlist", asyncRoute(async (_request, response) => {
    response.status(200).json({ context: "watchlist", items: await store.listInvestorWatchlist() });
  }));
}
