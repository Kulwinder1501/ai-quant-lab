import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FuturesBar } from "../../domain/session-volume-profile.js";
import { parseVolumeByTimeQuery, registerVolumeByTimeRoutes } from "./volume-by-time.routes.js";

/** 2026-10-22 is a Thursday. 16:30 IST = 11:00Z (after the close); 10:30 IST = 05:00Z (mid-session). */
const AFTER = new Date("2026-10-22T11:00:00.000Z");
const DURING = new Date("2026-10-22T05:00:00.000Z");

const OCT = "BANKNIFTY26OCTFUT";
const SEP = "BANKNIFTY26SEPFUT";

const open = (date: string) => new Date(Date.parse(`${date}T03:45:00.000Z`));

/**
 * Synthetic bars for one IST day (hand-built, not recorded): `count` one-minute bars from 09:15, each of volume
 * `perMinute` (a multiple of the lot size), minus any minutes in `skip`.
 */
function dayBars(date: string, { count = 375, perMinute = 30, skip = [] as number[] } = {}): FuturesBar[] {
  const bars: FuturesBar[] = [];
  for (let i = 0; i < count; i += 1) {
    if (skip.includes(i)) continue;
    bars.push({ openTime: new Date(open(date).getTime() + i * 60_000), open: 54_000, high: 54_002, low: 53_998, close: 54_000, volume: perMinute });
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
        bars: bars.length,
        barsWithVolume: bars.filter((bar) => bar.volume > 0).length,
        firstAt: bars[0]!.openTime,
        lastAt: bars[bars.length - 1]!.openTime,
      })).sort((a, b) => b.date.localeCompare(a.date));
    },
  };
}

let server: Server | null = null;

async function start(stored: Stored, now: Date = AFTER): Promise<{ base: string; calls: BarCall[] }> {
  const calls: BarCall[] = [];
  const app: Express = express();
  registerVolumeByTimeRoutes(app, { futuresBarRepository: fakeRepository(stored, calls) } as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseVolumeByTimeQuery", () => {
  const parse = (input: { underlying?: string; date?: string; bucket?: string; days?: string }) =>
    parseVolumeByTimeQuery({ underlying: input.underlying, date: input.date, bucket: input.bucket, days: input.days }, AFTER);

  it("defaults to 15-minute buckets against the previous 10 sessions", () => {
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, bucketMinutes: 15, baselineDays: 10 } });
  });

  it("offers 5, 15 and 30 minute buckets and 5, 10 or 20 baseline sessions, and nothing else", () => {
    for (const bucket of ["5", "15", "30"]) expect(parse({ bucket }).ok, bucket).toBe(true);
    for (const days of ["5", "10", "20"]) expect(parse({ days }).ok, days).toBe(true);
    for (const bucket of ["1", "10", "45", "15m", "0"]) expect(parse({ bucket }).ok, bucket).toBe(false);
    for (const days of ["1", "7", "30", "ten"]) expect(parse({ days }).ok, days).toBe(false);
  });

  it("shares the underlying and date rules with the other session routes", () => {
    expect(parse({ underlying: "SBIN" }).ok).toBe(false);
    expect(parse({ date: "2026-10-23" })).toEqual({ ok: false, error: "`date` is in the future." });
    expect(parse({ underlying: "nifty50", date: "2026-10-22" }).ok).toBe(true);
  });
});

describe("GET /api/v1/volume-by-time", () => {
  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start({});
    for (const query of ["bucket=7", "days=3", "date=2026-02-30", "underlying=SBIN"]) {
      expect((await fetch(`${base}/api/v1/volume-by-time?${query}`)).status, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("compares each bucket with the same bucket of the previous sessions of the same contract, as observed volume", async () => {
    // Today trades twice what each of the three earlier sessions did, minute for minute.
    const { base } = await start({ [OCT]: {
      "2026-10-22": dayBars("2026-10-22", { perMinute: 60 }),
      "2026-10-21": dayBars("2026-10-21"),
      "2026-10-20": dayBars("2026-10-20"),
      "2026-10-19": dayBars("2026-10-19"),
    } });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?bucket=15&days=5`)).json();

    expect(data).toMatchObject({ available: true, observed: true, sessionDate: "2026-10-22", bucketMinutes: 15, inProgress: false });
    expect(data.contract).toMatchObject({ symbol: OCT, lotSize: 30, expiryDate: "2026-10-27", daysToExpiry: 5 });
    expect(data.baseline).toMatchObject({ requestedSessions: 5, sessions: 3, dates: ["2026-10-19", "2026-10-20", "2026-10-21"], stoppedAtRoll: false });
    expect(data.buckets).toHaveLength(25);
    expect(data.buckets[0]).toMatchObject({ from: "09:15", to: "09:30", volume: 900, complete: true, baselineMedian: 450, baselineMean: 450, baselineSessions: 3, relative: 2, cumulative: 900, baselineCumulativeMedian: 450, cumulativeRelative: 2 });
    expect(data.buckets[24]).toMatchObject({ from: "15:15", to: "15:30", relative: 2, cumulative: 22_500, baselineCumulativeMedian: 11_250 });
    expect(data.day).toMatchObject({ total: 22_500, complete: true, baselineMedianTotal: 11_250, baselineSessionsWithTotal: 3, relative: 2 });
    expect(data.volumeUnit).toContain("not lots");
    expect(data.definitions.observed).toContain("Observed");
  });

  it("leaves an incomplete baseline bucket out, and says how many sessions each figure stands on", async () => {
    // One baseline session is missing a minute in the first bucket (minute 3), so that bucket has only two baseline sessions.
    const { base } = await start({ [OCT]: {
      "2026-10-22": dayBars("2026-10-22", { perMinute: 60 }),
      "2026-10-21": dayBars("2026-10-21"),
      "2026-10-20": dayBars("2026-10-20", { skip: [3] }),
      "2026-10-19": dayBars("2026-10-19"),
    } });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?days=5`)).json();
    expect(data.buckets[0]).toMatchObject({ baselineSessions: 2, baselineCumulativeSessions: 2 });
    expect(data.buckets[1]).toMatchObject({ baselineSessions: 3, baselineCumulativeSessions: 2 });   // cumulative needs every bucket before it too
    // A session with a hole has no day total, so the day baseline stands on the other two.
    expect(data.day).toMatchObject({ baselineSessionsWithTotal: 2 });
    expect(data.baseline.perSession.find((s: { sessionDate: string }) => s.sessionDate === "2026-10-20")).toMatchObject({ total: null, complete: false });
  });

  it("gives a session in progress no ratio for its unfinished buckets and no day total", async () => {
    // 10:30 IST: bars exist only to 10:29, 75 minutes in. With 15-minute buckets, five buckets are complete.
    const { base } = await start({ [OCT]: {
      "2026-10-22": dayBars("2026-10-22", { count: 75 }),
      "2026-10-21": dayBars("2026-10-21"),
    } }, DURING);
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?date=2026-10-22&days=5`)).json();
    expect(data.inProgress).toBe(true);
    expect(data.buckets[4]).toMatchObject({ complete: true, relative: 1, cumulative: 2250 });
    expect(data.buckets[5]).toMatchObject({ volume: null, complete: false, relative: null, cumulative: null });
    // The baseline has the figure the unfinished bucket will be compared with once it is complete.
    expect(data.buckets[5]!.baselineMedian).toBe(450);
    expect(data.day).toMatchObject({ total: null, complete: false, volumeSoFar: 2250, relative: null });
  });

  it("ends a baseline at a contract roll and says so, never mixing the contracts", async () => {
    // 2026-09-29 is the September expiry day; 09-30 and 10-01 are October's.
    const { base, calls } = await start({
      [OCT]: { "2026-10-01": dayBars("2026-10-01"), "2026-09-30": dayBars("2026-09-30") },
      [SEP]: { "2026-09-29": dayBars("2026-09-29"), "2026-09-28": dayBars("2026-09-28") },
    });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?date=2026-10-01&days=20`)).json();
    expect(data.baseline).toMatchObject({ sessions: 1, dates: ["2026-09-30"], stoppedAtRoll: true });
    expect(calls.every((c) => c.symbol === OCT)).toBe(true);
  });

  it("has no ratio, rather than a made-up one, when there is no earlier session", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time`)).json();
    expect(data.baseline).toMatchObject({ sessions: 0, dates: [] });
    expect(data.buckets[0]).toMatchObject({ volume: 450, baselineMedian: null, baselineSessions: 0, relative: null, cumulativeRelative: null });
    expect(data.day).toMatchObject({ total: 11_250, baselineMedianTotal: null, relative: null });
  });

  it("uses a shorter last bucket for 30-minute buckets", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?bucket=30`)).json();
    expect(data.buckets).toHaveLength(13);
    expect(data.buckets[12]).toMatchObject({ from: "15:15", to: "15:30", expectedBars: 15, barsPresent: 15, complete: true, volume: 450 });
  });

  it("never substitutes the next month for a front month whose bars are not stored", async () => {
    // 2026-09-10's front month is September; only October bars exist.
    const { base } = await start({ [OCT]: { "2026-09-10": dayBars("2026-09-10") } });
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time?date=2026-09-10`)).json();
    expect(data.available).toBe(false);
    expect(data.reason).toContain("next month");
  });

  it("says no sessions are stored when none are", async () => {
    const { base } = await start({});
    const { data } = await (await fetch(`${base}/api/v1/volume-by-time`)).json();
    expect(data).toMatchObject({ available: false, availableSessions: [] });
    expect(data.reason).toContain("last 60 days");
  });

  it("caches only once the day is over", async () => {
    const stored = { [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21") } };
    const live = await start(stored, DURING);
    expect((await fetch(`${live.base}/api/v1/volume-by-time?date=2026-10-22`)).headers.get("cache-control")).toBeNull();
    const over = await start(stored, AFTER);
    expect((await fetch(`${over.base}/api/v1/volume-by-time?date=2026-10-22`)).headers.get("cache-control")).toBe("private, max-age=600");
  });
});
