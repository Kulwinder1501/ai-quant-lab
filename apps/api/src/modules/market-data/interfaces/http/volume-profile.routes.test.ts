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
  const parse = (input: { underlying?: string; date?: string; rowPoints?: string; from?: string; to?: string; days?: string }) =>
    parseVolumeProfileQuery({ underlying: input.underlying, date: input.date, rowPoints: input.rowPoints, from: input.from, to: input.to, days: input.days }, DURING);

  it("defaults each index to a row height that makes a typical session 30-90 rows tall", () => {
    const whole = { fromMinute: 9 * 60 + 15, toMinute: 15 * 60 + 30 };
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, rowPoints: 10, range: whole, days: 1 } });
    expect(parse({ underlying: "nifty50" })).toEqual({ ok: true, value: { underlying: "NIFTY50", date: null, rowPoints: 5, range: whole, days: 1 } });
  });

  it("offers different row heights for each index, and refuses another index's choice", () => {
    expect(parse({ rowPoints: "20" }).ok).toBe(true);
    expect(parse({ rowPoints: "2" }).ok).toBe(false);
    expect(parse({ underlying: "NIFTY50", rowPoints: "2" }).ok).toBe(true);
    expect(parse({ underlying: "NIFTY50", rowPoints: "20" }).ok).toBe(false);
  });

  it("offers 1, 3, 5 or 10 sessions, one by default, and refuses anything else", () => {
    const days = (text: string | undefined) => { const result = parse({ days: text }); return result.ok ? result.value.days : result.error; };
    expect(days(undefined)).toBe(1);
    expect(days("3")).toBe(3);
    expect(days("10")).toBe(10);
    for (const bad of ["0", "2", "11", "5.0", "five", "-3"]) expect(days(bad), bad).toContain("`days` must be one of 1, 3, 5, 10");
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

describe("parseVolumeProfileQuery: range", () => {
  const parse = (from?: string, to?: string) => parseVolumeProfileQuery({ underlying: undefined, date: undefined, rowPoints: undefined, from, to }, DURING);
  const rangeOf = (from?: string, to?: string) => {
    const result = parse(from, to);
    return result.ok ? result.value.range : result.error;
  };

  it("reads from and to as IST clock times, and a missing edge is the session edge", () => {
    expect(rangeOf("09:30", "10:45")).toEqual({ fromMinute: 570, toMinute: 645 });
    expect(rangeOf("14:30", undefined)).toEqual({ fromMinute: 870, toMinute: 930 });
    expect(rangeOf(undefined, "10:15")).toEqual({ fromMinute: 555, toMinute: 615 });
    expect(rangeOf("", "")).toEqual({ fromMinute: 555, toMinute: 930 });
  });

  it("refuses a malformed, out-of-session, off-mark, backwards or too-short window with a reason", () => {
    expect(rangeOf("9.30", "10:00")).toContain("`from` must be a clock time");
    expect(rangeOf("10:00", "ten")).toContain("`to` must be a clock time");
    expect(rangeOf("09:00", "10:00")).toContain("within the regular session");
    expect(rangeOf("10:00", "15:45")).toContain("within the regular session");
    expect(rangeOf("09:17", "10:00")).toContain("multiples of 5");
    expect(rangeOf("12:00", "11:00")).toContain("at least 15 minutes");
    expect(rangeOf("12:00", "12:10")).toContain("at least 15 minutes");
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

  it("builds the profile from only the requested window, and reports its own clock, summary and quality", async () => {
    const { base } = await start({ [OCT]: { "2026-10-21": dayBars("2026-10-21"), "2026-10-22": dayBars("2026-10-22") } }, AFTER);
    const whole = (await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22`)).json()).data;
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22&from=09:15&to=10:15`)).json();

    expect(data.range).toMatchObject({ fromLabel: "09:15", toLabel: "10:15", isFullSession: false, stepMinutes: 5, minMinutes: 15 });
    expect(whole.range).toMatchObject({ fromLabel: "09:15", toLabel: "15:30", isFullSession: true });
    // 60 bars: minutes 0..59, volume 30 x (1 + minute % 5), so each group of five sums to 30 x 15.
    expect(data.profile.totalVolume).toBe(12 * 30 * 15);
    expect(data.profile.totalVolume).toBeLessThan(whole.profile.totalVolume);
    expect(data.closes).toHaveLength(60);
    expect(data.quality).toMatchObject({ expectedMinutes: 60, barsUsed: 60, missingMinutes: 0, complete: true });
    expect(data.range.summary).toMatchObject({ firstBarAt: "2026-10-22T03:45:00.000Z", lastBarAt: "2026-10-22T04:44:00.000Z" });
    // The whole session summary is still the whole session.
    expect(data.session.lastBarAt).toBe(whole.session.lastBarAt);
    // Previous-session levels stay the whole previous session, whatever the window.
    expect(data.previousSession).toEqual(whole.previousSession);
  });

  it("calls a window that has not finished yet partial, against the window length", async () => {
    // 10:30 IST: bars exist only to 10:29, i.e. 75 minutes into the session.
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22", { count: 75, postClose: false }) } }, DURING);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?from=10:00&to=12:00`)).json();
    expect(data.quality).toMatchObject({ expectedMinutes: 120, barsUsed: 30, missingMinutes: 90, complete: false });
  });

  it("says nothing was traded in a window that is empty, naming the window", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22", { count: 75, postClose: false }) } }, DURING);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?from=13:00&to=14:00`)).json();
    expect(data.available).toBe(false);
    expect(data.reason).toContain("13:00-14:00 IST");
  });

  it("rejects a bad window with 400 before any read", async () => {
    const { base, calls } = await start({});
    for (const query of ["from=09:00", "to=15:45", "from=12:00&to=11:00", "from=10:00&to=10:10", "from=10:02", "from=noon"]) {
      expect((await fetch(`${base}/api/v1/volume-profile?${query}`)).status, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("adds the last N sessions of the contract into one profile, and lists each session under it", async () => {
    const stored = { [OCT]: {
      "2026-10-22": dayBars("2026-10-22", { base: 54_000 }),
      "2026-10-21": dayBars("2026-10-21", { base: 53_700 }),
      "2026-10-20": dayBars("2026-10-20", { base: 53_400 }),
      "2026-10-19": dayBars("2026-10-19", { base: 53_100 }),
    } };
    const { base, calls } = await start(stored, AFTER);
    const one = (await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22`)).json()).data;
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22&days=3`)).json();

    expect(data.composite).toMatchObject({ requestedDays: 3, usedDays: 3, dates: ["2026-10-20", "2026-10-21", "2026-10-22"], stoppedAtRoll: false });
    expect(data.composite.perSession.map((s: { sessionDate: string }) => s.sessionDate)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    // Volume is conserved: the composite is the sum of its sessions, and every session has the same synthetic volume.
    const perDay = dayBars("2026-10-22", { postClose: false }).reduce((sum, bar) => sum + bar.volume, 0);
    expect(one.profile.totalVolume).toBe(perDay);
    expect(data.profile.totalVolume).toBe(3 * perDay);
    expect(data.composite.perSession.reduce((sum: number, s: { totalVolume: number }) => sum + s.totalVolume, 0)).toBe(3 * perDay);
    expect(data.profile.rows.reduce((sum: number, row: { volume: number }) => sum + row.volume, 0)).toBeCloseTo(3 * perDay, 1);
    // The profile spans the three days' price ranges; the single day does not.
    expect(data.profile.rows[0].low).toBeLessThan(one.profile.rows[0].low);
    expect(data.closes).toHaveLength(3 * 375);
    expect(data.quality).toMatchObject({ expectedMinutes: 3 * 375, barsUsed: 3 * 375, missingMinutes: 0, complete: true, outsideSessionBarsExcluded: 6 });
    // A composite already contains the days before it, so there is no separate previous session.
    expect(data.previousSession).toBeNull();
    expect(one.previousSession).not.toBeNull();
    // One read per session, all of the one contract.
    expect(calls.filter((c) => c.from.toISOString() === "2026-10-20T03:30:00.000Z").map((c) => c.symbol)).toEqual([OCT]);
  });

  it("applies the window to every session of a composite", async () => {
    const stored = { [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21") } };
    const { base } = await start(stored, AFTER);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22&days=3&from=09:15&to=10:15`)).json();
    expect(data.composite).toMatchObject({ requestedDays: 3, usedDays: 2 });
    expect(data.profile.totalVolume).toBe(2 * 12 * 30 * 15);
    expect(data.quality).toMatchObject({ expectedMinutes: 120, barsUsed: 120, complete: true });
    expect(data.closes).toHaveLength(120);
  });

  it("stops a composite at a contract roll and says so, never mixing the contracts", async () => {
    // 2026-09-29 is the September expiry day (September is still front month); 09-30 and 10-01 are October's.
    const { base, calls } = await start({
      [OCT]: { "2026-10-01": dayBars("2026-10-01"), "2026-09-30": dayBars("2026-09-30") },
      [SEP]: { "2026-09-29": dayBars("2026-09-29"), "2026-09-28": dayBars("2026-09-28") },
    }, AFTER);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-01&days=5`)).json();
    expect(data.composite).toMatchObject({ requestedDays: 5, usedDays: 2, dates: ["2026-09-30", "2026-10-01"], stoppedAtRoll: true });
    expect(data.profile.totalVolume).toBe(2 * dayBars("2026-10-01", { postClose: false }).reduce((sum, bar) => sum + bar.volume, 0));
    expect(calls.every((c) => c.symbol === OCT)).toBe(true);
  });

  it("reports fewer sessions than asked for when fewer are stored, without calling it a roll", async () => {
    const { base } = await start({ [OCT]: { "2026-10-22": dayBars("2026-10-22") } }, AFTER);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22&days=10`)).json();
    expect(data.composite).toMatchObject({ requestedDays: 10, usedDays: 1, stoppedAtRoll: false });
  });

  it("marks a session of the composite that does not cover the window, and the composite partial", async () => {
    const stored = { [OCT]: { "2026-10-22": dayBars("2026-10-22"), "2026-10-21": dayBars("2026-10-21", { count: 100, postClose: false }) } };
    const { base } = await start(stored, AFTER);
    const { data } = await (await fetch(`${base}/api/v1/volume-profile?date=2026-10-22&days=3&from=09:15&to=12:15`)).json();
    const byDate = Object.fromEntries(data.composite.perSession.map((s: { sessionDate: string; complete: boolean; barsUsed: number }) => [s.sessionDate, s]));
    expect(byDate["2026-10-22"]).toMatchObject({ complete: true, barsUsed: 180 });
    expect(byDate["2026-10-21"]).toMatchObject({ complete: false, barsUsed: 100 });
    expect(data.quality).toMatchObject({ expectedMinutes: 360, barsUsed: 280, missingMinutes: 80, complete: false });
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
