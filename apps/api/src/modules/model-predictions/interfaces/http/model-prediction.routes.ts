import type { Express, Request } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { InvalidHttpQueryError, queryString } from "../../../../interfaces/http/common/query.js";
import { InvalidModelPredictionQueryError } from "../../application/list-model-predictions.js";
import type { ModelPredictionLabel } from "../../domain/model-prediction.js";

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
    if (!/^\d+$/.test(limitText.trim())) throw new InvalidModelPredictionQueryError("limit must be a whole number.");
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

  return {
    instrumentSymbol: queryString(request, "instrument"),
    modelKey: queryString(request, "modelKey"),
    timeframe: queryString(request, "timeframe"),
    prediction: queryString(request, "prediction")?.toUpperCase() as ModelPredictionLabel | undefined,
    limit,
    cursor,
  };
}

export function registerModelPredictionRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "listModelPredictions" | "getModelPrediction">,
): void {
  app.get("/api/v1/model-predictions", async (request, response, next) => {
    try {
      const result = await dependencies.listModelPredictions.execute(parseListQuery(request));
      response.status(200).json({ data: result.records, page: { limit: result.limit, nextCursor: result.nextCursor } });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidModelPredictionQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/model-predictions/:id", async (request, response, next) => {
    try {
      const prediction = await dependencies.getModelPrediction.execute(request.params.id ?? "");
      if (!prediction) {
        response.status(404).json({ error: "Prediction not found" });
        return;
      }
      response.status(200).json({ data: prediction });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidModelPredictionQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
}
