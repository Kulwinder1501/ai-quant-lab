import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredDepthFrame } from "../../domain/depth-ladder.js";
import { parseDepthHeatmapQuery, parseDepthHistoryQuery, parseDepthLadderQuery, registerDepthRoutes } from "./depth.routes.js";

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
interface WindowCall { providerSymbol: string; from: Date; to: Date; maxLevels?: number }
interface SessionDay { date: string; firstAt: Date; lastAt: Date; framesCapped: number }

interface FakeData {
  /** Latest frame per symbol, for the ladder. */
  stored?: Record<string, StoredDepthFrame>;
  /** Frames per symbol, for the history. */
  windowFrames?: Record<string, StoredDepthFrame[]>;
  /** Session days per symbol, for the history's session list. */
  days?: Record<string, SessionDay[]>;
}

function fakeRepository(data: FakeData, calls: Call[], windowCalls: WindowCall[]) {
  return {
    async latestFrame(input: Call) {
      calls.push(input);
      return data.stored?.[input.providerSymbol] ?? null;
    },
    async framesInWindow(input: WindowCall) {
      windowCalls.push(input);
      return data.windowFrames?.[input.providerSymbol] ?? [];
    },
    async sessionDays(input: { providerSymbol: string }) {
      return data.days?.[input.providerSymbol] ?? [];
    },
  };
}

let server: Server | null = null;

async function startWith(
  data: FakeData,
  clockNow: Date = NOW,
): Promise<{ base: string; calls: Call[]; windowCalls: WindowCall[] }> {
  const calls: Call[] = [];
  const windowCalls: WindowCall[] = [];
  const app: Express = express();
  registerDepthRoutes(app, { depthFrameRepository: fakeRepository(data, calls, windowCalls) } as never, { now: () => clockNow });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls, windowCalls };
}

async function start(stored: Record<string, StoredDepthFrame>): Promise<{ base: string; calls: Call[] }> {
  const { base, calls } = await startWith({ stored });
  return { base, calls };
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
    expect(data.source).toContain("2 of 50 levels stored"); // the frame says how many it holds, not a fixed number
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

describe("parseDepthHistoryQuery", () => {
  const parse = (input: { underlying?: string; date?: string; bucketSeconds?: string }) =>
    parseDepthHistoryQuery({ underlying: input.underlying, date: input.date, bucketSeconds: input.bucketSeconds }, NOW);

  it("defaults to BANKNIFTY, the latest session, and one-minute buckets", () => {
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, bucketSeconds: 60 } });
  });

  it("accepts an IST date, a listed bucket size, and an underlying in any case", () => {
    expect(parse({ underlying: "nifty50", date: "2026-10-09", bucketSeconds: "300" })).toEqual({
      ok: true, value: { underlying: "NIFTY50", date: "2026-10-09", bucketSeconds: 300 },
    });
  });

  it("refuses a bucket size that is not offered, including text that merely starts with a number", () => {
    for (const bucketSeconds of ["45", "0", "-60", "1e2", "60abc", "6 0"]) {
      expect(parse({ bucketSeconds }).ok, bucketSeconds).toBe(false);
    }
  });

  it("refuses a date that is not a real calendar day, is not a bare date, or is after today in IST", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2026-10-9", "2026-10-12T00:00:00Z", "yesterday"]) {
      expect(parse({ date }).ok, date).toBe(false);
    }
    expect(parse({ date: "2026-10-13" })).toEqual({ ok: false, error: "`date` is in the future." });
    expect(parse({ date: "2026-10-12" }).ok).toBe(true); // today, IST
  });

  it("reads today in IST, not UTC: at 01:00 IST the UTC date is still yesterday", () => {
    // 2026-10-11T19:30:00Z is 2026-10-12 01:00 IST.
    const early = new Date("2026-10-11T19:30:00.000Z");
    expect(parseDepthHistoryQuery({ underlying: undefined, date: "2026-10-12", bucketSeconds: undefined }, early).ok).toBe(true);
  });

  it("refuses an unknown underlying", () => {
    expect(parse({ underlying: "SBIN" }).ok).toBe(false);
  });
});

describe("GET /api/v1/depth/history", () => {
  const SYMBOL = "NSE:BANKNIFTY26OCTFUT";
  const day = (date: string, framesCapped = 1000): SessionDay => ({
    date,
    firstAt: new Date(`${date}T03:39:00.000Z`),
    lastAt: new Date(`${date}T09:59:59.000Z`),
    framesCapped,
  });
  const frames = [
    frame(SYMBOL, new Date("2026-10-12T04:30:00.000Z")),
    frame(SYMBOL, new Date("2026-10-12T04:30:30.000Z")),
    frame(SYMBOL, new Date("2026-10-12T04:31:10.000Z")),
  ];

  it("rejects a bad query with 400 before any read", async () => {
    const { base, windowCalls } = await startWith({});
    for (const query of ["bucketSeconds=7", "date=2026-02-30", "underlying=SBIN", "date=2026-10-13"]) {
      expect((await fetch(`${base}/api/v1/depth/history?${query}`)).status, query).toBe(400);
    }
    expect(windowCalls).toHaveLength(0);
  });

  it("defaults to the latest stored session, reads that IST day as a half-open UTC window, and buckets it", async () => {
    const { base, windowCalls } = await startWith({
      windowFrames: { [SYMBOL]: frames },
      days: { [SYMBOL]: [day("2026-10-12"), day("2026-10-09")] },
    });
    const { data } = await (await fetch(`${base}/api/v1/depth/history`)).json();

    expect(windowCalls).toHaveLength(1);
    expect(windowCalls[0]!.providerSymbol).toBe(SYMBOL);
    expect(windowCalls[0]!.from.toISOString()).toBe("2026-10-12T03:30:00.000Z");
    expect(windowCalls[0]!.to.toISOString()).toBe("2026-10-12T10:00:00.000Z");
    expect(data).toMatchObject({
      available: true,
      underlying: "BANKNIFTY",
      contract: { providerSymbol: SYMBOL, expiryDate: "2026-10-27" },
      sessionDate: "2026-10-12",
      sessionTimezone: "Asia/Kolkata",
      inProgress: true,
      bucketSeconds: 60,
    });
    expect(data.buckets.map((b: { t: string; frames: number }) => [b.t, b.frames])).toEqual([
      ["2026-10-12T04:30:00.000Z", 2],
      ["2026-10-12T04:31:00.000Z", 1],
    ]);
    expect(data.counts).toMatchObject({ framesRead: 3, framesInSession: 3, framesOutsideSession: 0 });
    expect(data.definitions.gap).toContain("30 seconds");
    expect(data.definitions.wholeBook).toBeDefined();
  });

  it("lists the stored sessions newest first and marks a sparse day, so a nearly empty day is not offered as a full one", async () => {
    const { base } = await startWith({
      windowFrames: { [SYMBOL]: frames },
      days: { [SYMBOL]: [day("2026-10-09"), day("2026-10-12"), day("2026-10-08", 4)] },
    });
    const { data } = await (await fetch(`${base}/api/v1/depth/history`)).json();
    expect(data.availableSessions.map((s: { sessionDate: string; sparse: boolean }) => [s.sessionDate, s.sparse])).toEqual([
      ["2026-10-12", false], ["2026-10-09", false], ["2026-10-08", true],
    ]);
    expect(data.availableSessions[0]).toMatchObject({ providerSymbol: SYMBOL, framesCapped: 1000 });
  });

  it("reads only the first ten levels for the history, so a figure means the same on a 10-level and a 50-level day", async () => {
    const { base, windowCalls } = await startWith({ windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } });
    await fetch(`${base}/api/v1/depth/history`);
    expect(windowCalls[0]!.maxLevels).toBe(10);
  });

  it("lets the browser keep a finished session for ten minutes, and never caches one still being written", async () => {
    const live = await startWith({ windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12"), day("2026-10-09")] } });
    const past = await fetch(`${live.base}/api/v1/depth/history?date=2026-10-09`);
    expect(past.headers.get("cache-control")).toBe("private, max-age=600");
    const today = await fetch(`${live.base}/api/v1/depth/history?date=2026-10-12`);
    expect(today.headers.get("cache-control")).toBeNull();
    expect((await today.json()).data.inProgress).toBe(true);
  });

  it("calls today's session finished once the 15:30 IST close has passed: it stops refreshing and may be cached", async () => {
    // 2026-10-12 16:00 IST = 10:30Z, after the 10:00Z close.
    const closed = await startWith(
      { windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } },
      new Date("2026-10-12T10:30:00.000Z"),
    );
    const response = await fetch(`${closed.base}/api/v1/depth/history?date=2026-10-12`);
    expect(response.headers.get("cache-control")).toBe("private, max-age=600");
    expect((await response.json()).data.inProgress).toBe(false);
  });

  it("does not call a session in progress before the 09:00 IST open", async () => {
    // 2026-10-12 08:00 IST = 02:30Z.
    const early = await startWith(
      { windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } },
      new Date("2026-10-12T02:30:00.000Z"),
    );
    const { data } = await (await fetch(`${early.base}/api/v1/depth/history?date=2026-10-12`)).json();
    expect(data.inProgress).toBe(false);
  });

  it("reads the date it is asked for, with the bucket size it is asked for", async () => {
    const { base, windowCalls } = await startWith({
      windowFrames: { [SYMBOL]: frames },
      days: { [SYMBOL]: [day("2026-10-12"), day("2026-10-09")] },
    });
    const { data } = await (await fetch(`${base}/api/v1/depth/history?date=2026-10-09&bucketSeconds=300`)).json();
    expect(windowCalls[0]!.from.toISOString()).toBe("2026-10-09T03:30:00.000Z");
    expect(data.sessionDate).toBe("2026-10-09");
    expect(data.inProgress).toBe(false);
    expect(data.bucketSeconds).toBe(300);
  });

  it("falls through to the next month when the front month has no frames that day", async () => {
    const NOV = "NSE:BANKNIFTY26NOVFUT";
    const { base, windowCalls } = await startWith({ windowFrames: { [NOV]: [frame(NOV)] } });
    const { data } = await (await fetch(`${base}/api/v1/depth/history?date=2026-10-12`)).json();
    expect(windowCalls.map((c) => c.providerSymbol)).toEqual([SYMBOL, NOV]);
    expect(data.contract.providerSymbol).toBe(NOV);
  });

  it("says nothing is stored, and why, rather than returning an empty chart", async () => {
    const { base } = await startWith({});
    const { data } = await (await fetch(`${base}/api/v1/depth/history?date=2026-10-10`)).json();
    expect(data).toMatchObject({ available: false, sessionDate: "2026-10-10", contractsTried: [SYMBOL, "NSE:BANKNIFTY26NOVFUT"] });
    expect(data.reason).toContain("Weekends and exchange holidays");
  });

  it("says nothing is stored in the look-back when no session day is found and none was asked for", async () => {
    const { base } = await startWith({});
    const { data } = await (await fetch(`${base}/api/v1/depth/history?underlying=NIFTY50`)).json();
    expect(data).toMatchObject({ available: false, underlying: "NIFTY50", availableSessions: [] });
    expect(data.reason).toContain("last 60 days");
  });

  it("reports two capture sessions writing at once, so a doubled stream is visible", async () => {
    const both = [
      { ...frames[0]!, captureSessionId: "a" }, { ...frames[1]!, captureSessionId: "a", receivedAt: new Date("2026-10-12T04:32:00.000Z") },
      { ...frames[0]!, captureSessionId: "b", receivedAt: new Date("2026-10-12T04:30:20.000Z") },
      { ...frames[1]!, captureSessionId: "b", receivedAt: new Date("2026-10-12T04:33:00.000Z") },
    ];
    const { base } = await startWith({ windowFrames: { [SYMBOL]: both }, days: { [SYMBOL]: [day("2026-10-12")] } });
    const { data } = await (await fetch(`${base}/api/v1/depth/history`)).json();
    expect(data.captureSessions).toHaveLength(2);
    expect(data.concurrentWriters).toHaveLength(1);
  });
});

describe("parseDepthHeatmapQuery", () => {
  const parse = (input: { underlying?: string; date?: string; bucketSeconds?: string; rowPoints?: string }) =>
    parseDepthHeatmapQuery({ underlying: input.underlying, date: input.date, bucketSeconds: input.bucketSeconds, rowPoints: input.rowPoints }, NOW);

  it("defaults to BANKNIFTY, the latest session, one-minute columns and two-point rows", () => {
    expect(parse({})).toEqual({ ok: true, value: { underlying: "BANKNIFTY", date: null, bucketSeconds: 60, rowPoints: 2 } });
  });

  it("accepts the offered column and row sizes", () => {
    expect(parse({ bucketSeconds: "300", rowPoints: "5", date: "2026-10-09" })).toEqual({
      ok: true, value: { underlying: "BANKNIFTY", date: "2026-10-09", bucketSeconds: 300, rowPoints: 5 },
    });
  });

  it("refuses a size that is not offered, including 10-second columns the history allows but the grid does not", () => {
    for (const input of [{ bucketSeconds: "10" }, { bucketSeconds: "45" }, { rowPoints: "3" }, { rowPoints: "0.5" }, { rowPoints: "2px" }]) {
      expect(parse(input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it("shares the underlying and date rules with the history", () => {
    expect(parse({ underlying: "SBIN" }).ok).toBe(false);
    expect(parse({ date: "2026-02-30" }).ok).toBe(false);
    expect(parse({ date: "2026-10-13" })).toEqual({ ok: false, error: "`date` is in the future." });
  });
});

describe("GET /api/v1/depth/heatmap", () => {
  const SYMBOL = "NSE:BANKNIFTY26OCTFUT";
  const day = (date: string, framesCapped = 1000): SessionDay => ({
    date, firstAt: new Date(`${date}T03:39:00.000Z`), lastAt: new Date(`${date}T09:59:59.000Z`), framesCapped,
  });
  const frames = [
    frame(SYMBOL, new Date("2026-10-12T04:30:00.000Z")),
    frame(SYMBOL, new Date("2026-10-12T04:30:30.000Z")),
    frame(SYMBOL, new Date("2026-10-12T04:31:10.000Z")),
  ];

  it("rejects a bad query with 400 before any read", async () => {
    const { base, windowCalls } = await startWith({});
    for (const query of ["rowPoints=3", "bucketSeconds=10", "date=2026-02-30", "underlying=SBIN"]) {
      expect((await fetch(`${base}/api/v1/depth/heatmap?${query}`)).status, query).toBe(400);
    }
    expect(windowCalls).toHaveLength(0);
  });

  it("reads the latest stored session and returns a sparse grid, its colour scale, and the buckets it is indexed by", async () => {
    const { base, windowCalls } = await startWith({
      windowFrames: { [SYMBOL]: frames },
      days: { [SYMBOL]: [day("2026-10-12"), day("2026-10-09")] },
    });
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap`)).json();

    expect(windowCalls[0]!.from.toISOString()).toBe("2026-10-12T03:30:00.000Z");
    expect(data).toMatchObject({
      available: true, underlying: "BANKNIFTY", sessionDate: "2026-10-12", inProgress: true, bucketSeconds: 60, rowPoints: 2,
      contract: { providerSymbol: SYMBOL, expiryDate: "2026-10-27" },
    });
    expect(data.buckets.map((b: { t: string }) => b.t)).toEqual(["2026-10-12T04:30:00.000Z", "2026-10-12T04:31:00.000Z"]);
    expect(data.cellFields).toEqual(["bucketIndex", "row", "bidQty", "askQty", "framesCovering"]);
    expect(data.cells.length).toBeGreaterThan(0);
    for (const cell of data.cells) expect(cell[0] === 0 || cell[0] === 1).toBe(true);
    expect(data.scale.capQty).toBeGreaterThan(0);
    expect(data.scale.capPercentile).toBe(95);
    expect(data.rowRange.low).toBeLessThanOrEqual(data.rowRange.high);
    expect(data.definitions.empty).toContain("unknown");
    expect(data.counts).toMatchObject({ framesInSession: 3, framesUsed: 3 });
  });

  it("reads every stored level for the grid, and says how many levels each frame holds", async () => {
    const { base, windowCalls } = await startWith({ windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } });
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap`)).json();
    expect(windowCalls[0]!.maxLevels).toBe(50);
    expect(data.storedLevels).toEqual({ min: 2, max: 2 });
    expect(data.source).toContain("levels stored per frame: 2");
  });

  it("reports a range when days stored different numbers of levels, instead of one number for all", async () => {
    const mixed = [frame(SYMBOL, new Date("2026-10-12T04:30:00.000Z")), { ...frame(SYMBOL, new Date("2026-10-12T04:30:05.000Z")), levelsStored: 50 }];
    const { base } = await startWith({ windowFrames: { [SYMBOL]: mixed }, days: { [SYMBOL]: [day("2026-10-12")] } });
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap`)).json();
    expect(data.storedLevels).toEqual({ min: 2, max: 50 });
    expect(data.source).toContain("2 to 50");
  });

  it("carries the same holes, capture sessions and doubled-stream report as the history", async () => {
    const spaced = [...frames, frame(SYMBOL, new Date("2026-10-12T04:40:00.000Z"))];
    const { base } = await startWith({ windowFrames: { [SYMBOL]: spaced }, days: { [SYMBOL]: [day("2026-10-12")] } });
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap`)).json();
    // 04:30:30 -> 04:31:10 is 40 s and 04:31:10 -> 04:40:00 is 530 s: both exceed the 30 s threshold.
    expect(data.gaps.map((g: { seconds: number }) => g.seconds)).toEqual([40, 530]);
    expect(data.captureSessions).toHaveLength(1);
    expect(data.concurrentWriters).toEqual([]);
  });

  it("honours the requested date, column and row sizes", async () => {
    const { base, windowCalls } = await startWith({
      windowFrames: { [SYMBOL]: frames },
      days: { [SYMBOL]: [day("2026-10-12"), day("2026-10-09")] },
    });
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap?date=2026-10-09&bucketSeconds=300&rowPoints=5`)).json();
    expect(windowCalls[0]!.from.toISOString()).toBe("2026-10-09T03:30:00.000Z");
    expect(data).toMatchObject({ sessionDate: "2026-10-09", inProgress: false, bucketSeconds: 300, rowPoints: 5 });
  });

  it("caches a finished session for ten minutes and never one still being written", async () => {
    const live = await startWith({ windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } });
    expect((await fetch(`${live.base}/api/v1/depth/heatmap?date=2026-10-12`)).headers.get("cache-control")).toBeNull();
    const closed = await startWith(
      { windowFrames: { [SYMBOL]: frames }, days: { [SYMBOL]: [day("2026-10-12")] } },
      new Date("2026-10-12T10:30:00.000Z"),
    );
    expect((await fetch(`${closed.base}/api/v1/depth/heatmap?date=2026-10-12`)).headers.get("cache-control")).toBe("private, max-age=600");
  });

  it("says nothing is stored, and why, rather than returning an empty grid", async () => {
    const { base } = await startWith({});
    const { data } = await (await fetch(`${base}/api/v1/depth/heatmap?date=2026-10-10`)).json();
    expect(data).toMatchObject({ available: false, sessionDate: "2026-10-10", contractsTried: [SYMBOL, "NSE:BANKNIFTY26NOVFUT"] });
  });
});
