import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMutationRateLimiter } from "./middleware.js";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  const currentTime = 1_000;
  app.use(createMutationRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => currentTime }));
  app.get("/resource", (_request, response) => response.json({ ok: true }));
  app.post("/resource", (_request, response) => response.json({ ok: true }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("mutation rate limiter", () => {
  it("limits state-changing requests and leaves reads available", async () => {
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/resource`, { method: "POST" })).status).toBe(200);
      const second = await fetch(`${baseUrl}/resource`, { method: "POST" });
      expect(second.status).toBe(200);
      expect(second.headers.get("ratelimit-remaining")).toBe("0");

      const limited = await fetch(`${baseUrl}/resource`, { method: "POST" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toEqual({ error: "Too many state-changing requests. Try again later." });

      expect((await fetch(`${baseUrl}/resource`)).status).toBe(200);
    });
  });

  it("rejects invalid limiter configuration", () => {
    expect(() => createMutationRateLimiter({ maxRequests: 0, windowMs: 60_000 })).toThrow(/positive values/);
  });
});
