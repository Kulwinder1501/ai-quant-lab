import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerMarketDataRoutes } from "./market-data.routes.js";

/** Hand-built, not recorded: one book (the 11-03 weekly) with a single strike, as the default read returns when two books were stored. */
const OBSERVED_AT = new Date("2026-10-26T06:23:01.571Z");
const at = (iso: string) => new Date(`${iso}T10:00:00.000Z`);

function snapshot() {
  const quote = (optionType: "CE" | "PE") => ({
    expiryDate: at("2026-11-03"), expiryKind: "WEEKLY", strikePrice: 22_500, optionType,
    providerSymbol: `NSE:NIFTY26N0322500${optionType}`, providerToken: null,
    lastPrice: 200, bid: 199, ask: 201, volume: 100, openInterest: 5_000, previousOpenInterest: 4_000,
    openInterestChange: 1_000, vendorGreeks: null,
  });
  return {
    underlyingSymbol: "NIFTY50", provider: "fyers-api-v3", observedAt: OBSERVED_AT, underlyingValue: 22_500,
    quotes: [quote("CE"), quote("PE")], listedExpiries: [],
  };
}

interface Calls {
  latestSnapshot: Array<{ underlyingSymbol: string; expiryDate?: string }>;
  storedExpiriesAround: Array<[string, Date]>;
}

function fakeRepository(calls: Calls, options: { snapshotAvailable?: boolean; storedFails?: boolean } = {}) {
  return {
    async latestSnapshot(input: { underlyingSymbol: string; expiryDate?: string }) {
      calls.latestSnapshot.push(input);
      return options.snapshotAvailable === false ? null : snapshot();
    },
    async storedExpiriesAround(underlying: string, observedAt: Date) {
      calls.storedExpiriesAround.push([underlying, observedAt]);
      if (options.storedFails) throw new Error("database unavailable");
      return [
        { expiryDate: at("2026-10-27"), expiryKind: "MONTHLY" },
        { expiryDate: at("2026-11-03"), expiryKind: "WEEKLY" },
      ];
    },
    async listUnderlyings() { return []; },
  };
}

let server: Server | null = null;

async function start(options: { snapshotAvailable?: boolean; storedFails?: boolean } = {}): Promise<{ base: string; calls: Calls }> {
  const calls: Calls = { latestSnapshot: [], storedExpiriesAround: [] };
  const app: Express = express();
  registerMarketDataRoutes(app, { optionChainRepository: fakeRepository(calls, options), fyersLiveStreamer: {} } as never);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: String(error) });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("GET /api/v1/option-chain stored expiries", () => {
  it("lists the expiries stored in the run alongside the one book it returns, and leaves the default book alone", async () => {
    const { base, calls } = await start();
    const body = await (await fetch(`${base}/api/v1/option-chain?underlying=NIFTY50`)).json() as { data: Record<string, unknown> };

    expect(body.data.expiries).toEqual([{ expiryDate: "2026-11-03", expiryKind: "WEEKLY" }]);
    expect(body.data.storedExpiries).toEqual([
      { expiryDate: "2026-10-27", expiryKind: "MONTHLY" },
      { expiryDate: "2026-11-03", expiryKind: "WEEKLY" },
    ]);
    // The menu is looked up for the instant of the book that was returned, and the default read still passes no expiry.
    expect(calls.storedExpiriesAround).toEqual([["NIFTY50", OBSERVED_AT]]);
    expect(calls.latestSnapshot[0]?.expiryDate).toBeUndefined();
  });

  it("still returns the chain, with an empty menu, when the menu cannot be read", async () => {
    const { base } = await start({ storedFails: true });
    const response = await fetch(`${base}/api/v1/option-chain?underlying=NIFTY50`);
    const body = await response.json() as { data: { available: boolean; storedExpiries: unknown[] } };
    expect(response.status).toBe(200);
    expect(body.data.available).toBe(true);
    expect(body.data.storedExpiries).toEqual([]);
  });
});

describe("GET /api/v1/option-chain/stream expiry", () => {
  it("reads the requested expiry's book, and the newest book when none is asked for", async () => {
    const { base, calls } = await start({ snapshotAvailable: false });
    expect((await fetch(`${base}/api/v1/option-chain/stream?underlying=NIFTY50&expiry=2026-10-27`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/option-chain/stream?underlying=NIFTY50`)).status).toBe(404);
    expect(calls.latestSnapshot).toEqual([
      { underlyingSymbol: "NIFTY50", expiryDate: "2026-10-27" },
      { underlyingSymbol: "NIFTY50", expiryDate: undefined },
    ]);
  });

  it("refuses an expiry that is not an ISO date before reading anything", async () => {
    const { base, calls } = await start();
    const response = await fetch(`${base}/api/v1/option-chain/stream?underlying=NIFTY50&expiry=tomorrow`);
    expect(response.status).toBe(400);
    expect(calls.latestSnapshot).toEqual([]);
  });
});
