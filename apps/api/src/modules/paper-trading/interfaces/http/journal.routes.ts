import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { InvalidHttpQueryError } from "../../../../interfaces/http/common/query.js";
import { InvalidTradeHistoryQueryError } from "../../application/list-paper-trade-history.js";
import { parseTradeHistoryQuery } from "./paper-trading.routes.js";

/**
 * The Journal: Trade History's same filters (account/bot, instrument, side, exit reason,
 * outcome, date range), but each row also carries the strategy's entry-time reasoning and,
 * once reviewed, the measured account of why it won or lost.
 */
export function registerJournalRoutes(app: Express, dependencies: HttpDependencies): void {
  app.get("/api/v1/journal", async (request, response, next) => {
    try {
      const result = await dependencies.listJournalTrades.execute(parseTradeHistoryQuery(request));
      response.status(200).json({
        data: result.records,
        summary: result.summary,
        page: { limit: result.limit, truncated: result.truncated },
        context: { simulatedOnly: true, accounts: result.accounts },
      });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidTradeHistoryQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
}
