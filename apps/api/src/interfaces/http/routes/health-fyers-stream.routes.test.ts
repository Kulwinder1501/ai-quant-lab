import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamerDiagnostics } from "../../../infrastructure/market-data/fyers-live-streamer.js";
import { registerHealthRoutes } from "./health.routes.js";

let server: Server | null = null;

const DIAGNOSTICS: StreamerDiagnostics = {
  connected: true,
  wantedSymbols: 53,
  slotsUsedOnThisConnection: 53,
  lastTickAgeMs: 400,
  silentSymbols: ["NSE:BANKNIFTY26NOV54100CE"],
  silentSymbolCount: 1,
  deadSymbols: [],
  reconnectAttempts: 0,
  droppedMessages: 12,
  socketReplacements: { forSlots: 0, forSilentSymbols: 1 },
  lastReplacementAt: "2026-10-28T06:30:00.000Z",
};

async function start(streamer: { diagnostics(): StreamerDiagnostics } | null) {
  const app = express();
  registerHealthRoutes(app, { database: {} as never, fyersLiveStreamer: streamer as never });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("GET /api/v1/health/fyers-stream", () => {
  it("returns what the live socket is doing, so a freeze can be read before the API is restarted", async () => {
    const base = await start({ diagnostics: () => DIAGNOSTICS });
    const response = await fetch(`${base}/api/v1/health/fyers-stream`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: DIAGNOSTICS });
  });

  it("says plainly when live streaming is not configured", async () => {
    const base = await start(null);
    const response = await fetch(`${base}/api/v1/health/fyers-stream`);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/not configured/);
  });
});
