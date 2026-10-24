import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseCoverageQuery, recentWeekdays, registerDataCoverageRoutes } from "./data-coverage.routes.js";

/** 2026-10-23 is a Friday. 17:00 IST = 11:30Z (after the close); 10:30 IST = 05:00Z (mid-session). */
const AFTER = new Date("2026-10-23T11:30:00.000Z");
const DURING = new Date("2026-10-23T05:00:00.000Z");

const OCT_FUT = "BANKNIFTY26OCTFUT";
const OCT_DEPTH = "NSE:BANKNIFTY26OCTFUT";

/** An IST wall-clock time on a date, as an instant. */
const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - 330 * 60_000);

interface FakeData {
  futures?: Record<string, { bars: number; barsWithVolume?: number; first: string; last: string }>;
  snapshots?: Record<string, { inSession: number; first: string | null; last: string | null; pre?: number; post?: number }>;
  depth?: Record<string, { frames: number; first: string; last: string }>;
  latestDepthAt?: Date | null;
  latestSnapshotAt?: Date | null;
  /** The scheduler's OPTION_CHAIN runs, by IST date and `HH:MM`. */
  jobRuns?: Array<{ date: string; at: string; status: "COMPLETED" | "FAILED" | "RUNNING"; error?: string }>;
  /** The Fyers request ledger rows. */
  ledger?: Array<{ date: string; endpoint: string; count: number }>;
}

function fakes(data: FakeData) {
  return {
    database: {
      async query(sql: string) {
        if (sql.includes("scheduled_job_runs")) {
          return { rows: (data.jobRuns ?? []).map((run) => ({ scheduled_for: ist(run.date, run.at), status: run.status, error_details: run.error ?? null })) };
        }
        if (sql.includes("fyers_daily_request_ledger")) {
          return { rows: (data.ledger ?? []).map((row) => ({ date_key: row.date, endpoint: row.endpoint, request_count: row.count })) };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
      },
    },
    futuresBarRepository: {
      async sessionDays(input: { symbol: string }) {
        if (input.symbol !== OCT_FUT) return [];
        return Object.entries(data.futures ?? {}).map(([date, d]) => ({
          date, bars: d.bars, barsWithVolume: d.barsWithVolume ?? d.bars, firstAt: ist(date, d.first), lastAt: ist(date, d.last),
        })).sort((a, b) => b.date.localeCompare(a.date));
      },
    },
    optionChainRepository: {
      async snapshotCoverageDays() {
        return Object.entries(data.snapshots ?? {}).map(([date, d]) => ({
          date, inSessionMinutes: d.inSession, preOpenMinutes: d.pre ?? 0, postCloseMinutes: d.post ?? 0,
          firstAt: d.first ? ist(date, d.first) : null, lastAt: d.last ? ist(date, d.last) : null, expiries: 1,
        })).sort((a, b) => b.date.localeCompare(a.date));
      },
      async latestObservedAt() { return data.latestSnapshotAt ?? null; },
    },
    depthFrameRepository: {
      async sessionDays(input: { providerSymbol: string }) {
        if (input.providerSymbol !== OCT_DEPTH) return [];
        return Object.entries(data.depth ?? {}).map(([date, d]) => ({
          date, firstAt: ist(date, d.first), lastAt: ist(date, d.last), framesCapped: d.frames,
        })).sort((a, b) => b.date.localeCompare(a.date));
      },
      async latestFrame() { return data.latestDepthAt ? { receivedAt: data.latestDepthAt } : null; },
    },
  };
}

let server: Server | null = null;

async function start(data: FakeData, now: Date = AFTER): Promise<string> {
  const app: Express = express();
  registerDataCoverageRoutes(app, fakes(data) as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("recentWeekdays", () => {
  it("counts back over weekdays only, newest first, skipping weekends", () => {
    expect(recentWeekdays("2026-10-19", 3)).toEqual(["2026-10-19", "2026-10-16", "2026-10-15"]);
    // From a Saturday the first weekday is the Friday before.
    expect(recentWeekdays("2026-10-24", 2)).toEqual(["2026-10-23", "2026-10-22"]);
  });
});

describe("parseCoverageQuery", () => {
  it("defaults to 20 weekdays and offers 10, 20 or 40", () => {
    expect(parseCoverageQuery({ underlying: undefined, days: undefined }, AFTER)).toEqual({ ok: true, value: { underlying: "BANKNIFTY", days: 20 } });
    for (const days of ["10", "20", "40"]) expect(parseCoverageQuery({ underlying: "nifty50", days }, AFTER).ok, days).toBe(true);
    for (const days of ["5", "30", "ten"]) expect(parseCoverageQuery({ underlying: undefined, days }, AFTER).ok, days).toBe(false);
    expect(parseCoverageQuery({ underlying: "SBIN", days: undefined }, AFTER).ok).toBe(false);
  });
});

describe("GET /api/v1/data-coverage", () => {
  const data: FakeData = {
    futures: {
      "2026-10-23": { bars: 375, first: "09:15", last: "15:29" },
      "2026-10-22": { bars: 375, first: "09:15", last: "15:29" },
      "2026-10-21": { bars: 200, first: "09:15", last: "12:34" },
      "2026-10-19": { bars: 375, first: "09:15", last: "15:29" },
    },
    snapshots: {
      "2026-10-23": { inSession: 26, first: "09:23", last: "15:23", pre: 1, post: 2 },
      "2026-10-22": { inSession: 26, first: "09:41", last: "15:23", pre: 1, post: 2 },
      "2026-10-21": { inSession: 5, first: "10:11", last: "13:23", pre: 1 },
      "2026-10-20": { inSession: 9, first: "11:23", last: "13:23" },
    },
    depth: {
      "2026-10-23": { frames: 1000, first: "09:00", last: "15:29" },
      "2026-10-22": { frames: 1000, first: "09:00", last: "15:29" },
      "2026-10-21": { frames: 1000, first: "11:02", last: "15:29" },
      "2026-10-20": { frames: 10, first: "11:30", last: "13:00" },
    },
    latestDepthAt: new Date("2026-10-23T14:40:00.000Z"),
    latestSnapshotAt: new Date("2026-10-23T10:23:00.000Z"),
  };

  it("lists each weekday newest first with each source's counts, times and status", async () => {
    const base = await start(data);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.rows.map((row: { date: string }) => row.date)).toEqual([
      "2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12",
    ]);
    const byDate = Object.fromEntries(body.rows.map((row: { date: string }) => [row.date, row]));

    expect(byDate["2026-10-23"]).toMatchObject({
      futures: { symbol: OCT_FUT, bars: 375, status: "complete" },
      snapshots: { inSessionMinutes: 26, preOpenMinutes: 1, postCloseMinutes: 2, status: "complete" },
      depth: { symbol: OCT_DEPTH, framesCapped: 1000, capReached: true, status: "complete" },
      inProgress: false, probableHoliday: false, gapInSource: false,
    });
    // The 10-21 session is thin everywhere: short futures, 5 snapshots, depth that started at 11:02.
    expect(byDate["2026-10-21"]).toMatchObject({ futures: { status: "partial", bars: 200 }, snapshots: { status: "partial" }, depth: { status: "partial", capReached: true } });
    // 10-20: no futures bars, and the collectors only wrote stray rows (a holiday they have no calendar for): not a gap.
    expect(byDate["2026-10-20"]).toMatchObject({ futures: { status: "none", bars: 0 }, snapshots: { status: "partial" }, depth: { status: "partial", capReached: false }, probableHoliday: true, gapInSource: false });
    // 10-19: futures but no snapshots and no depth.
    expect(byDate["2026-10-19"]).toMatchObject({ futures: { status: "complete" }, snapshots: { status: "none" }, depth: { status: "none" }, gapInSource: true });
    // 10-16 and earlier: nothing from any source, most likely a holiday, and not counted as a gap.
    expect(byDate["2026-10-16"]).toMatchObject({ probableHoliday: true, gapInSource: false, futures: { status: "none" }, snapshots: { status: "none" }, depth: { status: "none" } });
  });

  it("judges snapshot days against the typical day, the median of the days that have any", async () => {
    const base = await start(data);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    // 26, 26, 5, 9 -> sorted 5, 9, 26, 26 -> median 17.5; 10-22 starts at 09:41 and ends 15:23 with 26 >= 12.25: complete.
    expect(body.typicalSnapshotMinutes).toBe(17.5);
    expect(body.rows[1].snapshots).toMatchObject({ status: "complete", typicalMinutes: 17.5 });
    expect(body.rows[2].snapshots.status).toBe("partial");
  });

  it("summarises each source and counts probable holidays and gap days", async () => {
    const base = await start(data);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.summary).toMatchObject({
      futures: { complete: 3, partial: 1, none: 6 },
      snapshots: { complete: 2, partial: 2, none: 6 },
      depth: { complete: 2, partial: 2, none: 6 },
      probableHolidays: 6,
      daysWithAGap: 1,
    });
  });

  it("reports when each source last wrote, at any hour", async () => {
    const base = await start(data);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.latest).toEqual({
      futuresBarAt: ist("2026-10-23", "15:29").toISOString(),
      snapshotAt: "2026-10-23T10:23:00.000Z",
      depthFrameAt: "2026-10-23T14:40:00.000Z",
    });
    expect(body.definitions.noData).toContain("inference");
  });

  it("says a session still running is in progress, and leaves it out of what the typical day is judged on", async () => {
    const base = await start({ ...data, snapshots: { ...data.snapshots, "2026-10-23": { inSession: 4, first: "09:23", last: "10:23" } } }, DURING);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.rows[0]).toMatchObject({ date: "2026-10-23", inProgress: true });
    // Today's 4 snapshots are excluded from the median: 26, 5, 9 -> 9.
    expect(body.typicalSnapshotMinutes).toBe(9);
  });

  it("has nothing but none and holidays on an empty database, and null freshness", async () => {
    const base = await start({});
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.summary).toMatchObject({ probableHolidays: 10, daysWithAGap: 0 });
    expect(body.typicalSnapshotMinutes).toBeNull();
    expect(body.latest).toEqual({ futuresBarAt: null, snapshotAt: null, depthFrameAt: null });
  });

  it("reports a source with nothing in the whole window once, and does not call it a gap on every day", async () => {
    const withoutDepth: FakeData = { ...data, depth: {}, latestDepthAt: null };
    const base = await start(withoutDepth);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.sourcesNotCollected).toEqual(["depth"]);
    const byDate = Object.fromEntries(body.rows.map((row: { date: string }) => [row.date, row]));
    // 10-23 and 10-22 have futures and snapshots whole: no gap, though depth has nothing.
    expect(byDate["2026-10-23"]).toMatchObject({ depth: { status: "none" }, gapInSource: false, probableHoliday: false });
    expect(byDate["2026-10-22"]).toMatchObject({ gapInSource: false });
    // A source that is collected still makes a gap: 10-19 has futures bars and no snapshots.
    expect(byDate["2026-10-19"]).toMatchObject({ gapInSource: true });
    expect(body.latest.depthFrameAt).toBeNull();
  });

  it("names no source as not collected when every source has something", async () => {
    const base = await start(data);
    const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
    expect(body.sourcesNotCollected).toEqual([]);
  });

  describe("why a day is thin", () => {
    const limit = "failed with HTTP 429, code -360. You have reached the Standard plan limit of 5,000 requests/day.";
    const runs = (date: string, times: string[], status: "COMPLETED" | "FAILED", error?: string) => times.map((at) => ({ date, at, status, error }));
    const twelve = ["09:23", "09:41", "09:53", "10:11", "10:23", "10:41", "10:53", "11:11", "11:23", "11:41", "11:53", "12:11"];
    const withCollectors: FakeData = {
      ...data,
      jobRuns: [
        // 10-21: 12 runs completed in session, then two failed on the daily limit (14:41 in session, 15:41 after the close).
        ...runs("2026-10-21", twelve, "COMPLETED"),
        ...runs("2026-10-21", ["14:41", "15:41"], "FAILED", limit),
        // 10-22: 8 runs completed in session.
        ...runs("2026-10-22", twelve.slice(0, 8), "COMPLETED"),
        // 10-20 (the holiday): a pre-open failure and an in-session one, both on the limit.
        ...runs("2026-10-20", ["09:11", "13:41"], "FAILED", limit),
      ],
      ledger: [
        { date: "2026-10-21", endpoint: "history", count: 1734 },
        { date: "2026-10-21", endpoint: "quotes:api", count: 2431 },
        { date: "2026-10-21", endpoint: "optionchain", count: 110 },
        { date: "2026-10-20", endpoint: "quotes:api", count: 4794 },
      ],
    };
    const rowsOf = async (d: FakeData) => {
      const base = await start(d);
      const { data: body } = await (await fetch(`${base}/api/v1/data-coverage?days=10`)).json();
      return Object.fromEntries(body.rows.map((row: { date: string }) => [row.date, row])) as Record<string, { collector: { optionChain: Record<string, unknown> | null; fyersRequests: Record<string, unknown> | null; partialFailureHidden: boolean } }>;
    };

    it("attaches each day's option-chain runs, counted and classified, with when the failures began and ended", async () => {
      const byDate = await rowsOf(withCollectors);
      expect(byDate["2026-10-21"]!.collector.optionChain).toMatchObject({
        runs: 14, completed: 12, failed: 2, completedInSession: 12, failedInSession: 1,
        causes: { "fyers-daily-limit": 2, "fyers-rate-limited": 0, "fyers-auth": 0, network: 0, other: 0 },
        firstFailureAt: ist("2026-10-21", "14:41").toISOString(),
        lastFailureAt: ist("2026-10-21", "15:41").toISOString(),
      });
      expect(byDate["2026-10-20"]!.collector.optionChain).toMatchObject({ runs: 2, failed: 2, failedInSession: 1, causes: { "fyers-daily-limit": 2 } });
    });

    it("attaches the Fyers request total of the day against the cap and the scheduler's guard, largest endpoint first", async () => {
      const byDate = await rowsOf(withCollectors);
      expect(byDate["2026-10-21"]!.collector.fyersRequests).toMatchObject({
        total: 4275, cap: 5000, guard: 4200, overCap: false, overGuard: true,
        byEndpoint: [{ endpoint: "quotes:api", count: 2431 }, { endpoint: "history", count: 1734 }, { endpoint: "optionchain", count: 110 }],
      });
      // The holiday: nearly all of it the API's own live-quote polling.
      expect(byDate["2026-10-20"]!.collector.fyersRequests).toMatchObject({ total: 4794, byEndpoint: [{ endpoint: "quotes:api", count: 4794 }] });
    });

    it("says nothing was recorded, not zero, for a day with no runs and no ledger row", async () => {
      const byDate = await rowsOf(withCollectors);
      expect(byDate["2026-10-23"]!.collector).toEqual({ optionChain: null, fyersRequests: null, partialFailureHidden: false });
    });

    it("reads back the note a completed run kept: which underlying it could not collect, counted once per run", async () => {
      const note = `PARTIAL ${JSON.stringify({ failures: [{ underlyingSymbol: "NIFTY50", reason: "Fyers option chain request failed (HTTP 429)" }] })}`;
      const noted: FakeData = {
        ...data,
        jobRuns: [
          ...runs("2026-10-22", twelve.slice(0, 5), "COMPLETED"),
          ...runs("2026-10-22", twelve.slice(5, 8), "COMPLETED", note),
          // A FAILED run's error text is not a completion note, whatever it looks like.
          ...runs("2026-10-22", ["14:41"], "FAILED", note),
        ],
      };
      const byDate = await rowsOf(noted);
      expect(byDate["2026-10-22"]!.collector.optionChain).toMatchObject({ completed: 8, failed: 1, partialRuns: 3, partialByUnderlying: { NIFTY50: 3 } });
    });

    it("flags a day on which the job completed many runs but the index has far fewer snapshots (a partial failure the status hides)", async () => {
      const byDate = await rowsOf(withCollectors);
      // 10-21: 12 completed in-session runs against 5 in-session snapshot minutes (5 < 6).
      expect(byDate["2026-10-21"]!.collector.partialFailureHidden).toBe(true);
      // 10-22: 8 completed runs against 26 snapshot minutes.
      expect(byDate["2026-10-22"]!.collector.partialFailureHidden).toBe(false);
      // 10-20 has no completed run at all.
      expect(byDate["2026-10-20"]!.collector.partialFailureHidden).toBe(false);
    });
  });

  it("rejects a bad query with 400", async () => {
    const base = await start({});
    for (const query of ["days=7", "underlying=SBIN"]) expect((await fetch(`${base}/api/v1/data-coverage?${query}`)).status, query).toBe(400);
  });
});
