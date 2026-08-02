import type { NextFunction, Request, Response } from "express";

export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = performance.now();
  response.on("finish", () => {
    console.info(JSON.stringify({
      level: "info",
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  });
  next();
}

export function notFoundHandler(_request: Request, response: Response): void {
  response.status(404).json({ error: "Route not found" });
}

export function errorHandler(
  _error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  response.status(500).json({ error: "Unexpected server error" });
}
