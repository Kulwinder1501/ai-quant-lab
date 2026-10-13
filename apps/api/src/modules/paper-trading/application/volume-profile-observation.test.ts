import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINIMUM_PROFILE_MINUTES,
  VOLUME_PROFILE_OBSERVATION_CODE,
  observeVolumeProfile,
  type ProfileObservationDatabase,
} from "./volume-profile-observation.js";

type Row = Record<string, unknown>;

interface Script {
  idea?: Row | null;
  session?: Row | null;
  bars?: Row[];
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
      return { rows: script.bars ?? twoZoneMinutes(320) };
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
  rows.push({ high: 22_600, low: 22_410, close: 22_500, volume: 50 });
  return rows;
}

const NOW = new Date("2026-10-13T05:00:00.000Z"); // 10:30 IST on 2026-10-13

function parseStamp(note: string): Record<string, unknown> {
  const match = /FRVP_OBS (\{.*\})$/.exec(note);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("observeVolumeProfile", () => {
  it("stamps where the entry sits against the prior session's profile", async () => {
    const { database } = fakeDatabase({});
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(note).toContain("log-only, no effect on entry");
    expect(note).toContain(VOLUME_PROFILE_OBSERVATION_CODE);
    const body = parseStamp(note!);
    expect(body).toMatchObject({ v: "frvp-rows48-v1", st: "OK", sess: "2026-10-12", fut: "NIFTY26OCTFUT", e: 22_500 });
    expect(["INSIDE_VALUE", "ABOVE_VAH", "BELOW_VAL"]).toContain(body.pos);
    expect(typeof body.poc).toBe("number");
    expect(body.cov).toBeCloseTo(321 / 375, 2);
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

  it("reads the bars of the session and contract it chose", async () => {
    const { database, calls } = fakeDatabase({});
    await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    const barRead = calls[calls.length - 1]!;
    expect(barRead.values).toEqual(["fut-1", "NIFTY50", "2026-10-12"]);
  });

  it("stamps NO_PRIOR_SESSION_FUTURES, with the entry, when no futures session exists", async () => {
    const { database } = fakeDatabase({ session: null });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!)).toMatchObject({ st: "NO_PRIOR_SESSION_FUTURES", e: 22_500 });
  });

  it("stamps THIN_SESSION rather than profiling a partial day", async () => {
    const { database } = fakeDatabase({ bars: twoZoneMinutes(MINIMUM_PROFILE_MINUTES - 10) });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!)).toMatchObject({ st: "THIN_SESSION", sess: "2026-10-12" });
  });

  it("stamps PROFILE_NOT_BUILT when the session had no volume or range", async () => {
    const flat = Array.from({ length: 320 }, () => ({ high: 22_500, low: 22_500, close: 22_500, volume: 100 }));
    const { database } = fakeDatabase({ bars: flat });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW });

    expect(parseStamp(note!)).toMatchObject({ st: "PROFILE_NOT_BUILT" });
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
    // Entry 22,900 is above everything the session traded.
    const { database } = fakeDatabase({ idea: { entry_price: 22_900 } });
    const note = await observeVolumeProfile({ database, underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "SHORT", now: NOW });

    expect(parseStamp(note!)).toMatchObject({ st: "OK", pos: "ABOVE_VAH" });
  });
});
