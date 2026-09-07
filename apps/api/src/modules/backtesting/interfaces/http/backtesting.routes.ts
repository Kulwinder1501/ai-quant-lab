import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { parseLimit } from "../../../../interfaces/http/common/query.js";
import { respondToRouteError } from "../../../../interfaces/http/common/route-errors.js";

export function registerBacktestingRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "database" | "dashboardRepository" | "runBacktest">,
): void {
  app.get("/api/v1/backtest-runs", async (request, response, next) => {
    try {
      const runs = await dependencies.dashboardRepository.listBacktestRuns(parseLimit(request) || 50);
      response.status(200).json({ data: runs });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/backtest-runs/:id", async (request, response, next) => {
    try {
      const details = await dependencies.dashboardRepository.getBacktestRunDetails(request.params.id || "");
      if (!details) {
        response.status(404).json({ error: "Backtest run not found" });
        return;
      }
      response.status(200).json({ data: details });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/backtest-runs", async (request, response, next) => {
    try {
      const { symbol, timeframe, startDate, endDate } = request.body || {};
      if (!symbol || !timeframe || !startDate || !endDate) {
        response.status(400).json({ error: "symbol, timeframe, startDate, and endDate are required." });
        return;
      }
      const instrumentResult = await dependencies.database.query(
        "SELECT id FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1",
        [String(symbol).toUpperCase()],
      );
      if (!instrumentResult.rows[0]) {
        response.status(404).json({ error: `Instrument ${symbol} not found.` });
        return;
      }
      const strategyResult = await dependencies.database.query(
        "SELECT id, configuration FROM strategy_versions WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1",
      );
      if (!strategyResult.rows[0]) {
        response.status(404).json({ error: "No active strategy version found in database." });
        return;
      }
      const result = await dependencies.runBacktest.execute({
        strategyVersionId: strategyResult.rows[0].id,
        strategyConfiguration: strategyResult.rows[0].configuration || {},
        instrumentId: instrumentResult.rows[0].id,
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
        },
      });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to run backtest");
    }
  });
}
