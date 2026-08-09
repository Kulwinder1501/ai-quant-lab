import type { NextFunction, Request, Response } from "express";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface MutationRateLimitOptions {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}

const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Per-process protection for state-changing endpoints. The API is single-node/local-first. */
export function createMutationRateLimiter({
  maxRequests,
  windowMs,
  now = Date.now,
}: MutationRateLimitOptions) {
  if (!Number.isInteger(maxRequests) || maxRequests <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Mutation rate-limit configuration must contain positive values.");
  }
  const buckets = new Map<string, RateLimitBucket>();

  return (request: Request, response: Response, next: NextFunction): void => {
    if (readOnlyMethods.has(request.method.toUpperCase())) {
      next();
      return;
    }

    const currentTime = now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1_000));
    response.setHeader("RateLimit-Limit", String(maxRequests));
    response.setHeader("RateLimit-Remaining", String(remaining));
    response.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1_000)));

    if (bucket.count > maxRequests) {
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json({ error: "Too many state-changing requests. Try again later." });
      return;
    }

    // Bound memory even if a hostile client can create many source addresses.
    if (buckets.size > 10_000) {
      for (const [bucketKey, candidate] of buckets) {
        if (candidate.resetAt <= currentTime) buckets.delete(bucketKey);
      }
    }
    next();
  };
}

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

export function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

export function notFoundHandler(_request: Request, response: Response): void {
  response.status(404).json({ error: "Route not found" });
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  console.error(JSON.stringify({
    level: "error",
    method: request.method,
    path: request.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  response.status(500).json({ error: "Unexpected server error" });
}
