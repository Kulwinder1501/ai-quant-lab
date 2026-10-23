import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredDepthFrame } from "../../domain/depth-ladder.js";
import { parseDepthLadderQuery, registerDepthRoutes } from "./depth.routes.js";

/** 2026-10-12 is a Monday; 10:00 IST = 04:30Z. */
const NOW = new Date("2026-10-12T04:30:01.000Z");

/** A synthetic frame: the route's job is resolution and framing, the arithmetic is tested in the domain. */
function frame(providerSymbol: string, receivedAt = new Date("2026-10-12T04:30:00.000Z")): StoredDepthFrame {
  return {
    providerSymbol,
    sequenceNo: 7,
    exchangeFeedTime: 1_792_000_000,
    receivedAt,
    isSnapshot: false,
    levelsStored: 2,
    levelsAvailable: 50,
    bidPrice: [54_200, 54_199.8],
    bidQty: [60, 30],
    bidOrders: [2, 1],
    askPrice: [54_220, 54_220.2],
    askQty: [30, 30],
    askOrders: [1, 1],
    totalBuyQty: 28_080,
    totalSellQty: 60_270,
    gapBefore: 0,
    isDuplicate: false,
    captureSessionId: "session-1",
  };
}

interface Call { providerSymbol: string; asOf?: Date }

function fakeRepository(stored: Record<string, StoredDepthFrame>, calls: Call[]) {
  return {
    async latestFrame(input: Call) {
      calls.push(input);
      return stored[input.providerSymbol] ?? null;
    },
  };
}

let server: Server | null = null;

async function start(stored: Record<string, StoredDepthFrame>): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const app: Express = express();
  registerDepthRoutes(app, { depthFrameRepository: fakeRepository(stored, calls) } as never, { now: () => NOW });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseDepthLadderQuery", () => {
  it("defaults to BANKNIFTY, the contract the collector follows, with no asOf", () => {
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: undefined }, NOW)).toEqual({
      ok: true, value: { underlying: "BANKNIFTY", asOf: null },
    });
  });

  it("accepts an underlying case-insensitively and an ISO instant with an offset", () => {
    const parsed = parseDepthLadderQuery({ underlying: "nifty50", asOf: "2026-10-12T04:00:00+00:00" }, NOW);
    expect(parsed).toMatchObject({ ok: true, value: { underlying: "NIFTY50" } });
    expect((parsed as { ok: true; value: { asOf: Date } }).value.asOf.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });

  it("refuses an unknown underlying, a bare date, a non-date, and a future instant", () => {
    expect(parseDepthLadderQuery({ underlying: "SBIN", asOf: undefined }, NOW).ok).toBe(false);
    // A bare date would be read in the server's timezone: refused rather than guessed.
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: "2026-10-12" }, NOW).ok).toBe(false);
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: "2026-10-12T04:00:00" }, NOW).ok).toBe(false);
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: "2026-13-45T00:00:00Z" }, NOW).ok).toBe(false);
    const future = parseDepthLadderQuery({ underlying: undefined, asOf: "2026-10-12T05:00:00Z" }, NOW);
    expect(future).toEqual({ ok: false, error: "`asOf` is in the future." });
  });

  it("tolerates a few seconds of clock skew on asOf, no more", () => {
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: "2026-10-12T04:30:05Z" }, NOW).ok).toBe(true);
    expect(parseDepthLadderQuery({ underlying: undefined, asOf: "2026-10-12T04:30:07Z" }, NOW).ok).toBe(false);
  });
});

describe("GET /api/v1/depth/ladder", () => {
  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start({});
    const response = await fetch(`${base}/api/v1/depth/ladder?underlying=SBIN`);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns the front month's latest book as a live ladder, with its definitions and provenance", async () => {
    const { base, calls } = await start({ "NSE:BANKNIFTY26OCTFUT": frame("NSE:BANKNIFTY26OCTFUT") });
    const response = await fetch(`${base}/api/v1/depth/ladder?underlying=BANKNIFTY`);
    expect(response.status).toBe(200);
    const { data } = await response.json();

    expect(calls).toEqual([{ providerSymbol: "NSE:BANKNIFTY26OCTFUT" }]); // front month first, no asOf
    expect(data).toMatchObject({
      available: true,
      underlying: "BANKNIFTY",
      contract: { providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27", lotSize: 30 },
      requestedAsOf: null,
    });
    expect(data.ladder.status).toBe("LIVE");
    expect(data.ladder.bestBid).toBe(54_200);
    expect(data.ladder.bids).toHaveLength(2);
    expect(data.definitions.wholeBook).toContain("whole-book totals");
    expect(data.source).toContain("top 10 of 50 levels");
  });

  it("falls through to the next month when the front month has no stored frame", async () => {
    const { base, calls } = await start({ "NSE:BANKNIFTY26NOVFUT": frame("NSE:BANKNIFTY26NOVFUT") });
    const { data } = await (await fetch(`${base}/api/v1/depth/ladder?underlying=BANKNIFTY`)).json();
    expect(calls.map((c) => c.providerSymbol)).toEqual(["NSE:BANKNIFTY26OCTFUT", "NSE:BANKNIFTY26NOVFUT"]);
    expect(data.contract.providerSymbol).toBe("NSE:BANKNIFTY26NOVFUT");
  });

  it("reports nothing stored, with the contracts tried, rather than an empty ladder", async () => {
    const { base } = await start({});
    const { data } = await (await fetch(`${base}/api/v1/depth/ladder?underlying=NIFTY50`)).json();
    expect(data).toMatchObject({
      available: false,
      underlying: "NIFTY50",
      contractsTried: ["NSE:NIFTY26OCTFUT", "NSE:NIFTY26NOVFUT"],
    });
    expect(data.reason).toContain("one contract at a time");
  });

  it("reads a past instant when asked, passes it to the repository, and marks the result historical", async () => {
    const stored = { "NSE:BANKNIFTY26OCTFUT": frame("NSE:BANKNIFTY26OCTFUT", new Date("2026-10-12T04:00:00.000Z")) };
    const { base, calls } = await start(stored);
    const { data } = await (await fetch(`${base}/api/v1/depth/ladder?underlying=BANKNIFTY&asOf=2026-10-12T04:00:30Z`)).json();
    expect(calls[0]!.asOf!.toISOString()).toBe("2026-10-12T04:00:30.000Z");
    expect(data.requestedAsOf).toBe("2026-10-12T04:00:30.000Z");
    expect(data.ladder.status).toBe("HISTORICAL");
  });

  it("marks an old frame STALE in session instead of presenting it as current", async () => {
    const stored = { "NSE:BANKNIFTY26OCTFUT": frame("NSE:BANKNIFTY26OCTFUT", new Date("2026-10-12T04:29:00.000Z")) };
    const { base } = await start(stored);
    const { data } = await (await fetch(`${base}/api/v1/depth/ladder?underlying=BANKNIFTY`)).json();
    expect(data.ladder.status).toBe("STALE");
    expect(data.ladder.ageSeconds).toBeGreaterThan(10);
  });
});
