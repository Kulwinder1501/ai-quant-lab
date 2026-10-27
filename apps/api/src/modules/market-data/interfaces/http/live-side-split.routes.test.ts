import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LiveSideSplit } from "../../domain/live-side-split.js";
import { registerLiveSideSplitRoutes } from "./live-side-split.routes.js";

/** 10:00 IST on Tuesday 2026-10-27, the October expiry day: the October contract is still the front month. */
const NOW = new Date("2026-10-27T04:30:00.000Z");
const NIFTY_OCT = "NSE:NIFTY26OCTFUT";

let server: Server | null = null;

async function start(options: { split?: LiveSideSplit; streamer?: { subscribe(symbols: string[]): void } | null; now?: Date } = {}) {
  const subscribed: string[][] = [];
  const streamer = options.streamer === undefined ? { subscribe: (symbols: string[]) => { subscribed.push(symbols); } } : options.streamer;
  const app = express();
  registerLiveSideSplitRoutes(
    app,
    { liveSideSplit: options.split ?? new LiveSideSplit(), fyersLiveStreamer: streamer as never },
    { now: () => options.now ?? NOW },
  );
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, subscribed };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const get = async (base: string, query = "") => (await fetch(`${base}/api/v1/volume-profile/live-side-split${query}`));

function fed(): LiveSideSplit {
  const split = new LiveSideSplit();
  const t = NOW.getTime();
  split.record({ symbol: NIFTY_OCT, ltp: 25_000, bid: 24_999.9, ask: 25_000.1, volume: 1_000 }, t - 10_000);
  split.record({ symbol: NIFTY_OCT, ltp: 25_000.1, bid: 24_999.9, ask: 25_000.1, volume: 1_130 }, t - 5_000); // +130 buy
  split.record({ symbol: NIFTY_OCT, ltp: 25_000, bid: 24_999.9, ask: 25_000.1, volume: 1_190 }, t - 1_000); // +60 inside
  return split;
}

describe("GET /api/v1/volume-profile/live-side-split", () => {
  it("rejects a bad query with 400", async () => {
    const { base } = await start();
    for (const query of ["?underlying=SBIN", "?rowPoints=7"]) expect((await get(base, query)).status, query).toBe(400);
  });

  it("says nothing has been counted, rather than returning zeros, before any volume has arrived", async () => {
    const { base } = await start();
    const { data } = await (await get(base, "?underlying=NIFTY50")).json();
    expect(data.available).toBe(false);
    expect(data.symbol).toBe("NIFTY26OCTFUT");
    expect(data.reason).toMatch(/No volume has been counted/);
    expect(data.definitions.estimate).toMatch(/estimate/i);
  });

  it("asks the socket for the front-month contract, so asking is what starts the count", async () => {
    const { base, subscribed } = await start();
    await get(base, "?underlying=NIFTY50");
    expect(subscribed).toEqual([[NIFTY_OCT]]);
  });

  it("does not touch the socket outside the session window, so a night-time request opens nothing", async () => {
    const { base, subscribed } = await start({ now: new Date("2026-10-27T13:00:00.000Z") }); // 18:30 IST
    const { data } = await (await get(base, "?underlying=NIFTY50")).json();
    expect(subscribed).toEqual([]);
    expect(data.available).toBe(false);
  });

  it("returns the estimated split with its unknown share, the since time and the wording to show", async () => {
    const { base } = await start({ split: fed() });
    const { data } = await (await get(base, "?underlying=NIFTY50&rowPoints=5")).json();
    expect(data.available).toBe(true);
    expect(data.estimated).toBe(true);
    expect(data.symbol).toBe("NIFTY26OCTFUT");
    expect(data.totals).toEqual({ buy: 130, sell: 0, unknown: 60, total: 190 });
    expect(data.unknownShare).toBeCloseTo(60 / 190, 12);
    expect(data.rows).toEqual([{ low: 25_000, high: 25_005, buy: 130, sell: 0, unknown: 60 }]);
    expect(data.since).toBe(new Date(NOW.getTime() - 5_000).toISOString());
    expect(data.definitions.sideRule).toMatch(/no ground truth/);
    expect(data.definitions.scope).toMatch(/restart/);
  });

  it("does not read a date: only today exists", async () => {
    const { base } = await start({ split: fed() });
    const { data } = await (await get(base, "?underlying=NIFTY50&date=2026-10-20")).json();
    expect(data.sessionDate).toBe("2026-10-27");
    expect(data.available).toBe(true);
  });

  it("reports an unavailable feed plainly when the server has no live socket", async () => {
    const { base } = await start({ streamer: null });
    const { data } = await (await get(base, "?underlying=NIFTY50")).json();
    expect(data.available).toBe(false);
    expect(data.reason).toMatch(/no live market feed/);
  });
});
