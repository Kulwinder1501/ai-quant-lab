import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionProfile, type FuturesBar } from "../../domain/session-volume-profile.js";
import { parseDevelopingQuery, registerDevelopingValueRoutes } from "./developing-value.routes.js";

/** 2026-10-22 is a Thursday. 16:30 IST = 11:00Z (after the close); 10:30 IST = 05:00Z (mid-session). */
const AFTER = new Date("2026-10-22T11:00:00.000Z");
const DURING = new Date("2026-10-22T05:00:00.000Z");
const OCT = "BANKNIFTY26OCTFUT";

const open = (date: string) => new Date(Date.parse(`${date}T03:45:00.000Z`));

/**
 * Synthetic bars for one IST day (hand-built, not recorded): the first 120 minutes near 54,000, the next 130 near 54,200,
 * the rest near 53,900, each minute a small range and a volume that is a multiple of the lot size, then two post-close bars.
 */
function dayBars(date: string, { count = 375, postClose = true } = {}): FuturesBar[] {
  const bars: FuturesBar[] = [];
  for (let i = 0; i < count; i += 1) {
    const centre = i < 120 ? 54_000 : i < 250 ? 54_200 : 53_900;
    bars.push({ openTime: new Date(open(date).getTime() + i * 60_000), open: centre, high: centre + 3, low: centre - 3, close: centre, volume: 30 * (1 + (i % 4)) });
  }
  if (postClose) {
    for (const minute of [375, 376]) bars.push({ openTime: new Date(open(date).getTime() + minute * 60_000), open: 50_000, high: 50_000, low: 50_000, close: 50_000, volume: 9_999 });
  }
  return bars;
}

interface Stored { [symbol: string]: { [date: string]: FuturesBar[] } }
interface BarCall { symbol: string; from: Date; to: Date }

function fakeRepository(stored: Stored, calls: BarCall[]) {
  return {
    async bars(input: BarCall) {
      calls.push(input);
      return Object.values(stored[input.symbol] ?? {}).flat().filter((bar) => bar.openTime >= input.from && bar.openTime < input.to);
    },
    async sessionDays(input: { symbol: string }) {
      return Object.entries(stored[input.symbol] ?? {}).map(([date, bars]) => ({
        date, bars: bars.length, barsWithVolume: bars.filter((bar) => bar.volume > 0).length, firstAt: bars[0]!.openTime, lastAt: bars[bars.length - 1]!.openTime,
      })).sort((a, b) => b.date.localeCompare(a.date));
    },
  };
}

let server: Server | null = null;

async function start(stored: Stored, now: Date = AFTER): Promise<{ base: string; calls: BarCall[] }> {
  const calls: BarCall[] = [];
  const app: Express = express();
  registerDevelopingValueRoutes(app, { futuresBarRepository: fakeRepository(stored, calls) } as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseDevelopingQuery", () => {
  const parse = (input: { underlying?: string; date?: string; rowPoints?: string; step?: string }) =>
    parseDevelopingQuery({ underlying: input.underlying, date: input.date, rowPoints: input.rowPoints, step: input.step }, AFTER);

  it("defaults to the index's row height and 30-minute checkpoints", () => {
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, rowPoints: 10, stepMinutes: 30 } });
    expect(parse({ underlying: "nifty50" })).toEqual({ ok: true, value: { underlying: "NIFTY50", date: null, rowPoints: 5, stepMinutes: 30 } });
  });

  it("offers 15, 30 and 60 minute checkpoints and the index's own row heights, and nothing else", () => {
    for (const step of ["15", "30", "60"]) expect(parse({ step }).ok, step).toBe(true);
    for (const step of ["5", "45", "0", "30m"]) expect(parse({ step }).ok, step).toBe(false);
    expect(parse({ rowPoints: "20" }).ok).toBe(true);
    expect(parse({ rowPoints: "2" }).ok).toBe(false);
    expect(parse({ underlying: "SBIN" }).ok).toBe(false);
    expect(parse({ date: "2026-10-23" })).toEqual({ ok: false, error: "`date` is in the future." });
  });
});

describe("GET /api/v1/volume-profile/developing", () => {
  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start({});
    for (const query of ["step=7", "rowPoints=7", "date=2026-02-30", "underlying=SBIN"]) {
      expect((await fetch(`${base}/api/v1/volume-profile/developing?${query}`)).status, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("rebuilds the profile at each checkpoint, as an estimate, and ends on the session's own profile", async () => {
    const day = dayBars("2026-10-22");
    const { base } = await start({ [OCT]: { "2026-10-22": day } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile/developing?step=60`)).json();

    expect(data).toMatchObject({ available: true, estimated: true, stepMinutes: 60, rowPoints: 10, sessionDate: "2026-10-22", contract: { symbol: OCT } });
    expect(data.points.map((p: { at: string }) => p.at)).toEqual(["10:15", "11:15", "12:15", "13:15", "14:15", "15:15", "15:30"]);
    // The first checkpoint is the first hour at 54,000: one cluster of rows, 60 complete minutes.
    expect(data.points[0]).toMatchObject({ barsUsed: 60, expectedBars: 60, newBars: 60, complete: true, lastClose: 54_000 });
    expect(data.points[0].val).toBeGreaterThanOrEqual(53_990);
    expect(data.points[0].vah).toBeLessThanOrEqual(54_010);

    const whole = buildSessionProfile(day.slice(0, 375), 10)!;
    expect(data.points[6]).toMatchObject({ at: "15:30", barsUsed: 375, complete: true, totalVolume: whole.totalVolume, poc: whole.poc, vah: whole.vah, val: whole.val, vwap: whole.vwap });
    // The 9,999-unit post-close bars at 50,000 are set aside, not in any checkpoint.
    expect(data.quality).toMatchObject({ barsUsed: 375, outsideSessionBarsExcluded: 2 });
    expect(data.closes).toHaveLength(375);
    expect(data.definitions.estimate).toContain("Estimated");
  });

  it("moves the POC as value moves: the heavier cluster at 54,200 takes over once it has more volume than the first (by 14:15)", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile/developing?step=60`)).json();
    const poc = data.points.map((p: { poc: number }) => p.poc);
    expect(poc[0]).toBeGreaterThanOrEqual(53_990);
    expect(poc[0]).toBeLessThanOrEqual(54_010);
    // At 14:15 (300 minutes in) the 54,200 cluster has 130 minutes against 120 at 54,000 (and 50 at 53,900): it holds the most volume.
    expect(poc[4]).toBeGreaterThanOrEqual(54_190);
    expect(poc[4]).toBeLessThanOrEqual(54_210);
  });

  it("reports no new bars after a session in progress's last bar, rather than a flat continuation", async () => {
    // 10:30 IST: bars exist only to 10:29, 75 minutes in.
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22", { count: 75, postClose: false }) } }, DURING);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile/developing?step=30`)).json();
    expect(data.inProgress).toBe(true);
    expect(data.points[1]).toMatchObject({ at: "10:15", barsUsed: 60, newBars: 30, complete: true });
    expect(data.points[2]).toMatchObject({ at: "10:45", barsUsed: 75, newBars: 15, complete: false });
    expect(data.points[3]).toMatchObject({ at: "11:15", barsUsed: 75, newBars: 0, complete: false });
    expect(data.quality.complete).toBe(false);
  });

  it("never substitutes the next month for a front month whose bars are not stored", async () => {
    const { base } = await start({ [OCT]: { "2026-09-10": dayBars("2026-09-10") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-profile/developing?date=2026-09-10`)).json();
    expect(data.available).toBe(false);
    expect(data.reason).toContain("next month");
  });

  it("says no sessions are stored when none are", async () => {
    const { base } = await start({});
    const { data } = await (await fetch(`${base}/api/v1/volume-profile/developing`)).json();
    expect(data).toMatchObject({ available: false, availableSessions: [] });
    expect(data.reason).toContain("last 60 days");
  });

  it("caches only once the day is over", async () => {
    const stored = { [OCT]: { "2026-10-22": dayBars("2026-10-22") } };
    const live = await start(stored, DURING);
    expect((await fetch(`${live.base}/api/v1/volume-profile/developing?date=2026-10-22`)).headers.get("cache-control")).toBeNull();
    const over = await start(stored, AFTER);
    expect((await fetch(`${over.base}/api/v1/volume-profile/developing?date=2026-10-22`)).headers.get("cache-control")).toBe("private, max-age=600");
  });
});
