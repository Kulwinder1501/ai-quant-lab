import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINIMUM_PROFILE_MINUTES,
  MINIMUM_TODAY_MINUTES,
  VOLUME_PROFILE_OBSERVATION_CODE,
  observeVolumeProfile,
  type ProfileObservationDatabase,
} from "./volume-profile-observation.js";

type Row = Record<string, unknown>;

interface Script {
  idea?: Row | null;
  session?: Row | null;
  /** The prior session's paired minutes. */
  prior?: Row[];
  /** Today's paired minutes up to now. */
  today?: Row[];
  fail?: boolean;
}

function fakeDatabase(script: Script) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database: ProfileObservationDatabase = {
    async query(text, values) {
      calls.push({ text, values });
      if (script.fail) throw new Error("connection reset");
      if (text.includes("FROM trade_ideas")) return { rows: script.idea === null ? [] : [script.idea ?? { entry_price: 22_500 }] };
      if (text.includes("HAVING COUNT")) return { rows: script.session === null ? [] : [script.session ?? defaultSession()] };
      // The paired-minutes read: the third value is the date being read.
      return { rows: values[2] === "2026-10-12" ? (script.prior ?? twoZoneMinutes(320)) : (script.today ?? twoZoneMinutes(40)) };
    },
  };
  return { database, calls };
}

function defaultSession(bars = 375): Row {
  return { instrument_id: "fut-1", symbol: "NIFTY26OCTFUT", session_date: "2026-10-12", volume: 3_000_000, bars };
}

/** `count` one-minute bars: half in a busy zone near 22,400, half near 22,600, with a thin one between. */
function twoZoneMinutes(count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i % 2 === 0 ? 22_400 : 22_600;
    rows.push({ high: base + 10, low: base, close: base + 5, volume: 1000 });
  }
  // The last row carries the open time of the latest minute used: 10:29 IST.
  rows.push({ high: 22_600, low: 22_410, close: 22_500, volume: 50, open_time: new Date("2026-10-13T04:59:00.000Z") });
  return rows;
}

/** Bars that pile up at the top of a 22,400-22,600 range: a P. */
function topHeavyMinutes(count: number): Row[] {
  const rows: Row[] = [{ high: 22_600, low: 22_400, close: 22_500, volume: 40 }];
  for (let i = 0; i < count; i += 1) rows.push({ high: 22_598, low: 22_580, close: 22_590, volume: 1000 });
  return rows;
}

const NOW = new Date("2026-10-13T05:00:00.000Z"); // 10:30 IST on 2026-10-13

function parseStamp(note: string): Record<string, any> {
  const match = /FRVP_OBS (\{.*\})$/.exec(note);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, any>;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("observeVolumeProfile", () => {
  it("stamps both profiles: the prior session and today so far", async () => {
    const { database } = fakeDatabase({});
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(note).toContain("log-only, no effect on entry");
    expect(note).toContain(VOLUME_PROFILE_OBSERVATION_CODE);
    const body = parseStamp(note!);
    expect(body).toMatchObject({ v: "frvp-rows48-v2", fut: "NIFTY26OCTFUT", e: 22_500 });
    expect(body.d1).toMatchObject({ st: "OK", sess: "2026-10-12", n: 321 });
    expect(body.d1.cov).toBeCloseTo(321 / 375, 2);
    expect(["P", "b", "D", "B"]).toContain(body.d1.sh);
    expect(typeof body.d1.stb).toBe("boolean");
    expect(typeof body.d1.cp).toBe("number");
    expect(["INSIDE_VALUE", "ABOVE_VAH", "BELOW_VAL"]).toContain(body.d1.pos);
    expect(typeof body.d1.poc).toBe("number");
    expect(body.d0).toMatchObject({ st: "OK", n: 41, asof: "10:29" });
    expect(["P", "b", "D", "B"]).toContain(body.d0.sh);
  });

  it("reads the shape of each profile on its own", async () => {
    const { database } = fakeDatabase({ prior: topHeavyMinutes(320), today: twoZoneMinutes(40) });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    const body = parseStamp(note!);
    expect(body.d1.sh).toBe("P");
    expect(body.d1.pp).toBeGreaterThan(0.67);
    expect(body.d0.sh).toBe("B");
  });

  it("asks for the last session before today in India, however late in the evening it runs", async () => {
    const { database, calls } = fakeDatabase({});
    await observeVolumeProfile({
      database, underlyingSymbol: "BANKNIFTY", tradeIdeaId: "idea-1", direction: "SHORT",
      now: new Date("2026-10-13T20:00:00.000Z"), // 01:30 IST on 2026-10-14
    });

    const lookup = calls.find((call) => call.text.includes("HAVING COUNT"))!;
    expect(lookup.values[0]).toBe("BANKNIFTY");
    expect(lookup.values[1]).toBe("2026-10-14");
    expect((lookup.values[3] as Date).toISOString()).toBe("2026-10-13T18:30:00.000Z");
  });

  it("reads today's bars only up to the last minute that had closed", async () => {
    const { database, calls } = fakeDatabase({});
    await observeVolumeProfile({
      database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG",
      now: new Date("2026-10-13T05:00:37.500Z"),
    });

    const todayRead = calls[calls.length - 1]!;
    expect(todayRead.values[0]).toBe("fut-1");
    expect(todayRead.values[2]).toBe("2026-10-13");
    expect((todayRead.values[3] as Date).toISOString()).toBe("2026-10-13T05:00:00.000Z");
  });

  it("reads the bars of the session and contract it chose, with no upper bound on a finished day", async () => {
    const { database, calls } = fakeDatabase({});
    await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    const priorRead = calls.find((call) => call.values[2] === "2026-10-12")!;
    expect(priorRead.values).toEqual(["fut-1", "NIFTY50", "2026-10-12", null]);
  });

  it("stamps NO_PRIOR_SESSION_FUTURES in both blocks, with the entry, when no futures session exists", async () => {
    const { database } = fakeDatabase({ session: null });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!)).toMatchObject({
      e: 22_500, d1: { st: "NO_PRIOR_SESSION_FUTURES" }, d0: { st: "NO_PRIOR_SESSION_FUTURES" },
    });
  });

  it("stamps THIN_SESSION rather than profiling a partial prior day, and still reads today", async () => {
    const { database } = fakeDatabase({ prior: twoZoneMinutes(MINIMUM_PROFILE_MINUTES - 10) });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    const body = parseStamp(note!);
    expect(body.d1).toMatchObject({ st: "THIN_SESSION", sess: "2026-10-12" });
    expect(body.d0.st).toBe("OK");
  });

  it("stamps NO_TODAY_FUTURES when no futures minute of today is in the database yet", async () => {
    const { database } = fakeDatabase({ today: [] });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    const body = parseStamp(note!);
    expect(body.d0).toEqual({ st: "NO_TODAY_FUTURES" });
    expect(body.d1.st).toBe("OK");
  });

  it("stamps TOO_EARLY, not a shape, on a handful of minutes", async () => {
    const { database } = fakeDatabase({ today: twoZoneMinutes(MINIMUM_TODAY_MINUTES - 10) });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!).d0).toMatchObject({ st: "TOO_EARLY", n: MINIMUM_TODAY_MINUTES - 9 });
    expect(parseStamp(note!).d0.sh).toBeUndefined();
  });

  it("stamps PROFILE_NOT_BUILT when a session had no volume or range", async () => {
    const flat = Array.from({ length: 320 }, () => ({ high: 22_500, low: 22_500, close: 22_500, volume: 100 }));
    const { database } = fakeDatabase({ prior: flat });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!).d1).toMatchObject({ st: "PROFILE_NOT_BUILT" });
  });

  it("stamps NO_ENTRY_PRICE when the idea cannot be read", async () => {
    const { database } = fakeDatabase({ idea: null });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "gone", direction: "LONG", now: NOW });

    expect(parseStamp(note!)).toMatchObject({ st: "NO_ENTRY_PRICE" });
  });

  it("returns null, and logs, when the lookup throws -- the trade opens unstamped", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { database } = fakeDatabase({ fail: true });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(note).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("opens unstamped");
  });

  it("puts a position at the entry's side of the value area", async () => {
    // Entry 22,900 is above everything either session traded.
    const { database } = fakeDatabase({ idea: { entry_price: 22_900 } });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "SHORT", now: NOW });

    const body = parseStamp(note!);
    expect(body.d1).toMatchObject({ st: "OK", pos: "ABOVE_VAH" });
    expect(body.d0).toMatchObject({ st: "OK", pos: "ABOVE_VAH" });
  });
});
