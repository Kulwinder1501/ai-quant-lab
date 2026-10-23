import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FuturesBar } from "../../domain/session-volume-profile.js";
import { parseVolumeProfileQuery, registerVolumeProfileRoutes } from "./volume-profile.routes.js";

/** 2026-10-22 is a Thursday. 10:30 IST = 05:00Z (mid-session); 16:30 IST = 11:00Z (after the close). */
const DURING = new Date("2026-10-22T05:00:00.000Z");
const AFTER = new Date("2026-10-22T11:00:00.000Z");

const OCT = "BANKNIFTY26OCTFUT";
const SEP = "BANKNIFTY26SEPFUT";

/** 09:15 IST on a date, as UTC. */
const open = (date: string) => new Date(Date.parse(`${date}T03:45:00.000Z`));

/**
 * Synthetic bars for one IST day (hand-built, not recorded): `count` one-minute bars from 09:15, a small deterministic
 * walk, volume in multiples of the lot size, then two post-close bars at 15:30 and 15:31 that must be set aside.
 */
function dayBars(date: string, { count = 375, base = 54_000, postClose = true } = {}): FuturesBar[] {
  const bars: FuturesBar[] = [];
  for (let i = 0; i < count; i += 1) {
    const close = base + (i % 20);
    bars.push({ openTime: new Date(open(date).getTime() + i * 60_000), open: close - 1, high: close + 2, low: close - 2, close, volume: 30 * (1 + (i % 5)) });
  }
  if (postClose) {
    for (const minute of [375, 376]) {
      bars.push({ openTime: new Date(open(date).getTime() + minute * 60_000), open: base, high: base, low: base, close: base, volume: 9_999 });
    }
  }
  return bars;
}

interface Stored { [symbol: string]: { [date: string]: FuturesBar[] } }
interface BarCall { symbol: string; from: Date; to: Date }

function fakeRepository(stored: Stored, calls: BarCall[]) {
  return {
    async bars(input: BarCall) {
      calls.push(input);
      const days = stored[input.symbol] ?? {};
      return Object.values(days).flat().filter((bar) => bar.openTime >= input.from && bar.openTime < input.to);
    },
    async sessionDays(input: { symbol: string }) {
      const days = stored[input.symbol] ?? {};
      return Object.entries(days).map(([date, bars]) => ({
        date,
        bars: bars.filter((bar) => bar.openTime.getUTCHours() * 60 + bar.openTime.getUTCMinutes() < 10 * 60).length,
        barsWithVolume: bars.filter((bar) => bar.volume > 0).length,
        firstAt: bars[0]!.openTime,
        lastAt: bars[bars.length - 1]!.openTime,
      })).sort((a, b) => b.date.localeCompare(a.date));
    },
  };
}

let server: Server | null = null;

async function start(stored: Stored, now: Date = DURING): Promise<{ base: string; calls: BarCall[] }> {
  const calls: BarCall[] = [];
  const app: Express = express();
  registerVolumeProfileRoutes(app, { futuresBarRepository: fakeRepository(stored, calls) } as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseVolumeProfileQuery", () => {
  const parse = (input: { underlying?: string; date?: string; rowPoints?: string }) =>
    parseVolumeProfileQuery({ underlying: input.underlying, date: input.date, rowPoints: input.rowPoints }, DURING);

  it("defaults each index to a row height that makes a typical session 30-90 rows tall", () => {
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, rowPoints: 10 } });
    expect(parse({ underlying: "nifty50" })).toEqual({ ok: true, value: { underlying: "NIFTY50", date: null, rowPoints: 5 } });
  });

  it("offers different row heights for each index, and refuses another index's choice", () => {
    expect(parse({ rowPoints: "20" }).ok).toBe(true);
    expect(parse({ rowPoints: "2" }).ok).toBe(false);
    expect(parse({ underlying: "NIFTY50", rowPoints: "2" }).ok).toBe(true);
    expect(parse({ underlying: "NIFTY50", rowPoints: "20" }).ok).toBe(false);
  });

  it("refuses a row height that is not a whole listed number", () => {
    for (const rowPoints of ["7", "0", "-10", "10.5", "10px", "1e1"]) expect(parse({ rowPoints }).ok, rowPoints).toBe(false);
  });

  it("shares the underlying and date rules with the depth routes", () => {
    expect(parse({ underlying: "SBIN" }).ok).toBe(false);
    expect(parse({ date: "2026-02-30" }).ok).toBe(false);
    expect(parse({ date: "2026-10-23" })).toEqual({ ok: false, error: "`date` is in the future." });
    expect(parse({ date: "2026-10-22" }).ok).toBe(true);
  });
});

describe("GET /api/v1/volume-profile", () => {
  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start({});
    for (const query of ["rowPoints=7", "date=2026-02-30", "underlying=SBIN", "date=2026-10-23"]) {
      expect((await fetch(`${base}/api/v1/volume-profile?${query}`)).status, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("builds the latest stored session's profile from the front month, as an estimate, and sets the post-close bars aside", async () => {
    const { base, calls } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile`)).json();

    expect(data).toMatchObject({
      available: true,
      underlying: "BANKNIFTY",
      contract: { symbol: OCT, providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27", lotSize: 30 },
      sessionDate: "2026-10-22",
      rowPoints: 10,
      rowPointsChoices: [5, 10, 20],
      estimated: true,
      inProgress: true,
    });
    expect(data.volumeUnit).toContain("not lots");
    // 09:00-16:00 IST on the day, so the pre-open and post-close bars are seen and counted.
    expect(calls[0]!.symbol).toBe(OCT);
    expect(calls[0]!.from.toISOString()).toBe("2026-10-22T03:30:00.000Z");
    expect(calls[0]!.to.toISOString()).toBe("2026-10-22T10:30:00.000Z");
    expect(data.quality).toMatchObject({ barsUsed: 375, missingMinutes: 0, outsideSessionBarsExcluded: 2, complete: true });
    // The 9,999-unit post-close bars at 54,000 would have dominated the profile: they are not in it.
    const expectedTotal = dayBars("2026-10-22", { postClose: false }).reduce((sum, bar) => sum + bar.volume, 0);
    expect(data.profile.totalVolume).toBe(expectedTotal);
    expect(data.closes).toHaveLength(375);
    expect(data.sensitivity).toMatchObject({ comparedWithBarMinutes: 5 });
    expect(data.definitions.estimate).toContain("Estimated");
  });

  it("never substitutes the next month for a front month whose bars are not stored", async () => {
    // 2026-09-10's front month is the September contract; only October bars exist.
    const { base, calls } = await start({ [OCT]: { "2026-09-10": dayBars("2026-09-10") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-09-10`)).json();
    expect(data).toMatchObject({ available: false, sessionDate: "2026-09-10", frontMonth: SEP });
    expect(data.reason).toContain(SEP);
    expect(data.reason).toContain("not used in its place");
    expect(calls.every((call) => call.symbol === SEP || call.symbol === OCT)).toBe(true);
    expect(calls.filter((call) => call.from.toISOString().startsWith("2026-09-10")).map((call) => call.symbol)).toEqual([SEP]);
  });

  it("lists a day only under the contract that was front month on it", async () => {
    const { base } = await start({
      [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-09-10": dayBars("2026-09-10") },
      [SEP]: { "2026-09-10": dayBars("2026-09-10") },
    });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile`)).json();
    const listed = data.availableSessions.map((s: { sessionDate: string; symbol: string }) => [s.sessionDate, s.symbol]);
    expect(listed).toContainEqual(["2026-10-22", OCT]);
    expect(listed).toContainEqual(["2026-09-10", SEP]);
    expect(listed).not.toContainEqual(["2026-09-10", OCT]);
  });

  it("takes the previous session's levels from the next older stored day, with the same row height", async () => {
    const { base } = await start({
      [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21", { base: 53_500 }), "2026-10-19": dayBars("2026-10-19", { base: 52_000 }) },
    });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile`)).json();
    expect(data.previousSession).toMatchObject({ sessionDate: "2026-10-21", symbol: OCT, complete: true });
    expect(data.previousSession.poc).toBeGreaterThan(53_400);
    expect(data.previousSession.poc).toBeLessThan(53_600);
    const asked = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-21`)).json();
    expect(asked.data.previousSession.sessionDate).toBe("2026-10-19");
  });

  it("has no previous session for the oldest stored day", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } });
    expect((await (await fetch(`${base}/api/v1/volume-profile`)).json()).data.previousSession).toBeNull();
  });

  it("marks a day with too few bars as incomplete, in the list and in its own quality", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22", { count: 200, postClose: false }) } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile`)).json();
    expect(data.availableSessions[0]).toMatchObject({ sessionDate: "2026-10-22", complete: false });
    expect(data.quality).toMatchObject({ barsUsed: 200, missingMinutes: 175, complete: false });
  });

  it("says nothing was traded rather than drawing an empty profile", async () => {
    const quiet = dayBars("2026-10-22", { postClose: false }).map((bar) => ({ ...bar, volume: 0 }));
    const { base } = await start({ [OCT]: { "2026-10-22": quiet } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22`)).json();
    expect(data).toMatchObject({ available: false, frontMonth: OCT });
    expect(data.reason).toContain("No traded volume");
  });

  it("says no sessions are stored when none are, with the look-back it searched", async () => {
    const { base } = await start({});
    const { data } = await (await fetch(`${base}/api/v1/volume-profile`)).json();
    expect(data).toMatchObject({ available: false, availableSessions: [] });
    expect(data.reason).toContain("last 60 days");
  });

  it("honours the requested date and row height", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-21&rowPoints=5`)).json();
    expect(data).toMatchObject({ sessionDate: "2026-10-21", rowPoints: 5, inProgress: false });
    expect(data.profile.rowPoints).toBe(5);
  });

  it("is in progress between 09:15 and 15:40 IST on its own day, and caches only once the day is over", async () => {
    const stored = { [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21") } };
    const live = await start(stored, DURING);
    const mid = await fetch(`${live.base}/api/v1/volume-profile?date=2026-10-22`);
    expect(mid.headers.get("cache-control")).toBeNull();
    expect((await mid.json()).data.inProgress).toBe(true);

    const over = await start(stored, AFTER);
    const done = await fetch(`${over.base}/api/v1/volume-profile?date=2026-10-22`);
    expect(done.headers.get("cache-control")).toBe("private, max-age=600");
    expect((await done.json()).data.inProgress).toBe(false);

    const past = await fetch(`${over.base}/api/v1/volume-profile?date=2026-10-21`);
    expect(past.headers.get("cache-control")).toBe("private, max-age=600");
  });

  it("works for NIFTY with its own contract and row choices", async () => {
    const { base } = await start({ NIFTY26OCTFUT: { "2026-10-22": dayBars("2026-10-22", { base: 22_600 }) } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?underlying=NIFTY50`)).json();
    expect(data).toMatchObject({ available: true, underlying: "NIFTY50", rowPoints: 5, rowPointsChoices: [2, 5, 10], contract: { symbol: "NIFTY26OCTFUT", lotSize: 65 } });
  });
});
