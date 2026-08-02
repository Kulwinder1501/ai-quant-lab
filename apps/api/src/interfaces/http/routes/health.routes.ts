import type { Express } from "express";
import { checkDatabaseReadiness } from "../../../infrastructure/database/database.js";
import type { HttpDependencies } from "../dependencies.js";

export function registerHealthRoutes(app: Express, { database }: Pick<HttpDependencies, "database">): void {
  app.get("/api/v1/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "ai-quant-lab-api" });
  });

  app.get("/api/v1/health/ready", async (_request, response) => {
    try {
      const databaseStatus = await checkDatabaseReadiness(database);
      response.status(200).json({ status: "ready", database: databaseStatus });
    } catch {
      response.status(503).json({ status: "not_ready", database: { ready: false } });
    }
  });
}
