import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FuturesBar } from "../../domain/session-volume-profile.js";
import { parseRealizedMovesQuery, registerRealizedMovesRoutes } from "./realized-moves.routes.js";

/** 2026-10-23 is a Friday. 17:00 IST = 11:30Z (after the close); 10:30 IST = 05:00Z (mid-session). */
const AFTER = new Date("2026-10-23T11:30:00.000Z");
const DURING = new Date("2026-10-23T05:00:00.000Z");
const OCT = "BANKNIFTY26OCTFUT";

/** A synthetic session (hand-built): flat at `open` except the second bar reaches `high`, the third `low`, the last closes at `close`. */
function dayBars(date: string, f: { open: number; high: number; low: number; close: number }, count = 375): FuturesBar[] {
  const start = Date.parse(`${date}T03:45:00.000Z`);
  return Array.from({ length: count }, (_, i) => {
    const close = i === count - 1 ? f.close : f.open;
    return {
      openTime: new Date(start + i * 60_000), open: f.open, close, volume: 30,
      high: Math.max(f.open, close, i === 1 ? f.high : 0),
      low: Math.min(f.open, close, i === 2 ? f.low : Number.POSITIVE_INFINITY),
    };
  });
}

type Stored = Record<string, Record<string, FuturesBar[]>>;

function fakeRepository(stored: Stored, calls: Array<{ symbol: string; from: Date }>) {
  return {
    async bars(input: { symbol: string; from: Date; to: Date }) {
      calls.push({ symbol: input.symbol, from: input.from });
      return Object.values(stored[input.symbol] ?? {}).flat().filter((bar) => bar.openTime >= input.from && bar.openTime < input.to);
    },
    async sessionDays(input: { symbol: string }) {
      return Object.entries(stored[input.symbol] ?? {}).map(([date, bars]) => ({
        date, bars: bars.length, barsWithVolume: bars.length, firstAt: bars[0]!.openTime, lastAt: bars[bars.length - 1]!.openTime,
      })).sort((a, b) => b.date.localeCompare(a.date));
    },
  };
}

let server: Server | null = null;

async function start(stored: Stored, now: Date = AFTER): Promise<{ base: string; calls: Array<{ symbol: string; from: Date }> }> {
  const calls: Array<{ symbol: string; from: Date }> = [];
  const app: Express = express();
  registerRealizedMovesRoutes(app, { futuresBarRepository: fakeRepository(stored, calls) } as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseRealizedMovesQuery", () => {
  it("defaults to BANKNIFTY and 10 sessions, and offers 5, 10 or 20", () => {
    expect(parseRealizedMovesQuery({ underlying: undefined, window: undefined }, AFTER)).toEqual({ ok: true, value: { underlying: "BANKNIFTY", window: 10 } });
    for (const window of ["5", "10", "20"]) expect(parseRealizedMovesQuery({ underlying: "nifty50", window }, AFTER).ok, window).toBe(true);
    for (const window of ["3", "30", "ten", "0"]) expect(parseRealizedMovesQuery({ underlying: undefined, window }, AFTER).ok, window).toBe(false);
    expect(parseRealizedMovesQuery({ underlying: "SBIN", window: undefined }, AFTER).ok).toBe(false);
  });
});

describe("GET /api/v1/realized-moves", () => {
  // Closes 100, 104, 101, 106 on four consecutive weekdays of one contract.
  const stored: Stored = { [OCT]: {
    "2026-10-20": dayBars("2026-10-20", { open: 100, high: 101, low: 99, close: 100 }),
    "2026-10-21": dayBars("2026-10-21", { open: 100, high: 106, low: 99, close: 104 }),
    "2026-10-22": dayBars("2026-10-22", { open: 104, high: 105, low: 100, close: 101 }),
    "2026-10-23": dayBars("2026-10-23", { open: 101, high: 108, low: 100, close: 106 }),
  } };

  it("lists each session newest first with its range and close-to-close move, and averages the window", async () => {
    const { base } = await start(stored);
    const { data } = await (await fetch(`${base}/api/v1/realized-moves?window=5`)).json();

    expect(data).toMatchObject({ available: true, underlying: "BANKNIFTY", window: 5, windowChoices: [5, 10, 20] });
    expect(data.sessions.map((s: { sessionDate: string }) => s.sessionDate)).toEqual(["2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20"]);
    expect(data.sessions[0]).toMatchObject({ complete: true, rangePoints: 8, closeToClosePoints: 5, previousSessionDate: "2026-10-22" });
    expect(data.sessions[1]).toMatchObject({ rangePoints: 5, closeToClosePoints: -3 });
    expect(data.sessions[3]).toMatchObject({ rangePoints: 2, closeToClosePoints: null, previousSessionDate: null });
    // Window of 5, four sessions stored: all four, three of which have a close-to-close move (4, 3, 5 in size).
    expect(data.statistics).toMatchObject({ sessionsInWindow: 4, closeToCloseCount: 3, rangeCount: 4, meanAbsCloseToClosePoints: 4, fromDate: "2026-10-20", toDate: "2026-10-23" });
    expect(data.definitions.observed).toContain("Nothing is estimated");
  });

  it("reads one more session than the window, so the oldest move has the close it needs, and no more", async () => {
    const { base, calls } = await start(stored);
    await fetch(`${base}/api/v1/realized-moves?window=5`);
    // window + 2 = 7 listed, only 4 stored: four reads, oldest first.
    expect(calls).toHaveLength(4);
    const many = await start({ [OCT]: Object.fromEntries(Array.from({ length: 8 }, (_, i) => {
      const date = `2026-10-${String(12 + i).padStart(2, "0")}`;   // 10-12 .. 10-19 (all weekdays or not: the listing does not care)
      return [date, dayBars(date, { open: 100, high: 101, low: 99, close: 100 })];
    })) });
    await fetch(`${many.base}/api/v1/realized-moves?window=5`);
    expect(many.calls).toHaveLength(7);
  });

  it("leaves a session that is still running out of the averages, and says it is in progress", async () => {
    const { base } = await start(stored, DURING);
    const { data } = await (await fetch(`${base}/api/v1/realized-moves?window=5`)).json();
    expect(data.sessions[0]).toMatchObject({ sessionDate: "2026-10-23", inProgress: true, complete: false, rangePoints: null, closeToClosePoints: null });
    expect(data.statistics).toMatchObject({ sessionsInWindow: 3, toDate: "2026-10-22", meanAbsCloseToClosePoints: 3.5 });   // |+4| and |-3|
  });

  it("does not compute a move across a contract roll", async () => {
    // 2026-09-29 is the September expiry day (September is still front month); 09-30 is October's.
    const { base } = await start({
      BANKNIFTY26SEPFUT: { "2026-09-29": dayBars("2026-09-29", { open: 100, high: 101, low: 99, close: 100 }) },
      [OCT]: {
        "2026-09-30": dayBars("2026-09-30", { open: 130, high: 131, low: 129, close: 130 }),
        "2026-10-01": dayBars("2026-10-01", { open: 130, high: 133, low: 129, close: 132 }),
      },
    }, new Date("2026-10-01T11:30:00.000Z"));
    const { data } = await (await fetch(`${base}/api/v1/realized-moves?window=5`)).json();
    const byDate = Object.fromEntries(data.sessions.map((s: { sessionDate: string }) => [s.sessionDate, s]));
    expect(byDate["2026-09-30"]).toMatchObject({ closeToClosePoints: null, rangePoints: 2 });
    expect(byDate["2026-10-01"]).toMatchObject({ closeToClosePoints: 2 });
  });

  it("says nothing is stored when nothing is", async () => {
    const { base } = await start({});
    const { data } = await (await fetch(`${base}/api/v1/realized-moves`)).json();
    expect(data).toMatchObject({ available: false, sessions: [], reason: "No futures bars with volume are stored for BANKNIFTY." });
    expect(data.statistics.sessionsInWindow).toBe(0);
  });

  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start(stored);
    for (const query of ["window=7", "underlying=SBIN"]) expect((await fetch(`${base}/api/v1/realized-moves?${query}`)).status, query).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
