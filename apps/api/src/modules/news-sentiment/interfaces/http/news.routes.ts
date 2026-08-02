import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";

export function registerNewsRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "listNews" | "ingestNews">,
): void {
  app.get("/api/v1/market-news", async (request, response, next) => {
    try {
      const provider = queryString(request, "provider")?.toUpperCase() as any;
      const sentimentLabel = queryString(request, "sentiment")?.toUpperCase() as any;
      const symbol = queryString(request, "symbol")?.toUpperCase();
      const search = queryString(request, "search");
      const limitText = queryString(request, "limit");
      const result = await dependencies.listNews.execute({
        provider,
        sentimentLabel,
        symbol,
        search,
        limit: limitText ? Number(limitText) : 50,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/market-news/refresh", async (_request, response, next) => {
    try {
      response.status(200).json({ data: await dependencies.ingestNews.execute() });
    } catch (error) {
      next(error);
    }
  });
}
