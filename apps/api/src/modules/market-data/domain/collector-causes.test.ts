import { describe, expect, it } from "vitest";
import {
  PARTIAL_FAILURE_MAX_SHARE,
  PARTIAL_FAILURE_MIN_RUNS,
  classifyJobFailure,
  completedRunsExceedSnapshots,
  istDateOf,
  summariseFyersRequests,
  summariseJobRuns,
  type JobRun,
} from "./collector-causes.js";

/** An IST wall-clock time on a date, as an instant (IST is UTC+05:30). */
const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - 330 * 60_000);

describe("classifyJobFailure", () => {
  it("reads the Fyers daily-limit refusal (HTTP 429, code -360) as the daily limit", () => {
    const text = "npm run data:collect:option-chain exited with code 1. Last stdout output: {\"reason\":\"Fyers option-chain request for NSE:NIFTY50-INDEX failed with HTTP 429, code -360. You've reached the Standard plan limit of 5,000 requests/day.\"}";
    expect(classifyJobFailure(text)).toBe("fyers-daily-limit");
    expect(classifyJobFailure("HTTP 429 ... 5,000 requests/day")).toBe("fyers-daily-limit");
    expect(classifyJobFailure("plan limit of 5,000 requests/day reached")).toBe("fyers-daily-limit");
  });

  it("calls any other HTTP 429, such as one with no code, rate-limited rather than the daily limit", () => {
    expect(classifyJobFailure("Fyers request failed with HTTP 429, code -300. Too many requests per second.")).toBe("fyers-rate-limited");
    expect(classifyJobFailure("Fyers option-chain request for NSE:NIFTY50-INDEX failed with HTTP 429, code none.")).toBe("fyers-rate-limited");
  });

  it("reads a request that never got an answer as a network failure", () => {
    expect(classifyJobFailure("{\"failures\":[{\"underlyingSymbol\":\"NIFTY50\",\"reason\":\"fetch failed\"}]}")).toBe("network");
    expect(classifyJobFailure("read ECONNRESET")).toBe("network");
    expect(classifyJobFailure("connect ETIMEDOUT 10.0.0.1:443")).toBe("network");
    expect(classifyJobFailure("getaddrinfo ENOTFOUND api-t1.fyers.in")).toBe("network");
  });

  it("reads token and session errors as authentication", () => {
    expect(classifyJobFailure("Fyers credential is not session-usable (EXPIRED): The Fyers access token expired at 2026-10-22T22:20:13.947Z.")).toBe("fyers-auth");
    expect(classifyJobFailure("request failed with HTTP 401 Unauthorized")).toBe("fyers-auth");
    expect(classifyJobFailure("Fyers error code -16: token invalid")).toBe("fyers-auth");
    expect(classifyJobFailure("the access token is invalid")).toBe("fyers-auth");
  });

  it("matches the error code as a whole number, so -160 is not -16", () => {
    expect(classifyJobFailure("failed with code -160")).toBe("other");
    expect(classifyJobFailure("failed with code -80")).toBe("other");
    expect(classifyJobFailure("failed with code -8")).toBe("fyers-auth");
  });

  it("calls anything else, including nothing, other", () => {
    expect(classifyJobFailure("npm run data:collect:option-chain exited with code 1. Last stdout output:")).toBe("other");
    expect(classifyJobFailure("")).toBe("other");
    expect(classifyJobFailure(null)).toBe("other");
  });

  it("tests the daily limit first, so a limit message that mentions a token is still the limit", () => {
    expect(classifyJobFailure("HTTP 429, code -360, 5,000 requests/day; your token is expired")).toBe("fyers-daily-limit");
  });
});

describe("istDateOf", () => {
  it("is the IST calendar date, which can differ from the UTC date", () => {
    expect(istDateOf(new Date("2026-10-22T20:00:00.000Z"))).toBe("2026-10-23");   // 01:30 IST the next day
    expect(istDateOf(new Date("2026-10-22T18:29:00.000Z"))).toBe("2026-10-22");   // 23:59 IST
  });
});

describe("summariseJobRuns", () => {
  const run = (date: string, hhmm: string, status: JobRun["status"], errorDetails: string | null = null): JobRun => ({ scheduledFor: ist(date, hhmm), status, errorDetails });
  const limit = "failed with HTTP 429, code -360. 5,000 requests/day";

  it("counts each IST day's runs by status, and says how many of them were inside the session", () => {
    const days = summariseJobRuns([
      run("2026-10-16", "09:11", "COMPLETED"),      // pre-open: a run, but not an in-session one
      run("2026-10-16", "09:23", "COMPLETED"),
      run("2026-10-16", "10:41", "COMPLETED"),
      run("2026-10-16", "11:11", "FAILED", limit),
      run("2026-10-16", "15:41", "FAILED", limit),  // post-close
      run("2026-10-16", "15:53", "RUNNING"),
    ]);
    expect(days.get("2026-10-16")).toMatchObject({ runs: 6, completed: 3, failed: 2, running: 1, completedInSession: 2, failedInSession: 1 });
  });

  it("classifies each failure, and keeps the first and the last failure time", () => {
    const days = summariseJobRuns([
      run("2026-10-20", "13:53", "FAILED", limit),
      run("2026-10-20", "09:11", "FAILED", "token expired"),
      run("2026-10-20", "14:11", "FAILED", "exited with code 1"),
      run("2026-10-20", "14:41", "FAILED", limit),
    ]);
    const day = days.get("2026-10-20")!;
    expect(day.causes).toEqual({ "fyers-daily-limit": 2, "fyers-rate-limited": 0, "fyers-auth": 1, network: 0, other: 1 });
    // Oldest first, whatever order they were given in.
    expect(day.firstFailureAt).toBe(ist("2026-10-20", "09:11").toISOString());
    expect(day.lastFailureAt).toBe(ist("2026-10-20", "14:41").toISOString());
  });

  it("has no failure times for a day with none, and a day with no runs is absent rather than zero", () => {
    const days = summariseJobRuns([run("2026-10-22", "09:23", "COMPLETED")]);
    expect(days.get("2026-10-22")).toMatchObject({ failed: 0, firstFailureAt: null, lastFailureAt: null, causes: { "fyers-daily-limit": 0, "fyers-rate-limited": 0, "fyers-auth": 0, network: 0, other: 0 } });
    expect(days.has("2026-10-21")).toBe(false);
  });

  it("puts a run just after IST midnight on the next IST day", () => {
    const days = summariseJobRuns([{ scheduledFor: new Date("2026-10-22T19:00:00.000Z"), status: "COMPLETED", errorDetails: null }]);
    expect([...days.keys()]).toEqual(["2026-10-23"]);
  });
});

describe("summariseJobRuns: completed runs with a partial-failure note", () => {
  const note = (...symbols: string[]) => `PARTIAL ${JSON.stringify({ failures: symbols.map((underlyingSymbol) => ({ underlyingSymbol, reason: "HTTP 429" })) })}`;
  const done = (hhmm: string, completionNote: string | null): JobRun => ({ scheduledFor: ist("2026-10-26", hhmm), status: "COMPLETED", errorDetails: null, completionNote });

  it("counts the completed runs that named an underlying they could not collect, and how many named each", () => {
    const day = summariseJobRuns([
      done("09:23", null),
      done("09:41", note("NIFTY50")),
      done("09:53", note("NIFTY50", "SBIN")),
      done("10:11", note("NIFTY50 (tradable expiry 2026-10-27)")),     // the same underlying's second book
    ]).get("2026-10-26")!;
    expect(day).toMatchObject({ completed: 4, failed: 0, partialRuns: 3 });
    expect(day.partialByUnderlying).toEqual({ NIFTY50: 3, SBIN: 1 });
  });

  it("counts an underlying once per run, however many of its entries a run names", () => {
    const day = summariseJobRuns([done("09:23", note("NIFTY50", "NIFTY50 (tradable expiry 2026-10-27)"))]).get("2026-10-26")!;
    expect(day.partialByUnderlying).toEqual({ NIFTY50: 1 });
  });

  it("leaves runs with no note, an older run without the field, or a note that is not a partial-run note out of the count", () => {
    const day = summariseJobRuns([
      done("09:23", null),
      { scheduledFor: ist("2026-10-26", "09:41"), status: "COMPLETED", errorDetails: null },
      done("09:53", "something else entirely"),
    ]).get("2026-10-26")!;
    expect(day).toMatchObject({ completed: 3, partialRuns: 0, partialByUnderlying: {} });
  });
});

describe("summariseFyersRequests", () => {
  const row = (dateKey: string, endpoint: string, requestCount: number) => ({ dateKey, endpoint, requestCount });

  it("totals each day across endpoints, largest endpoint first", () => {
    const days = summariseFyersRequests([row("2026-10-22", "history", 1804), row("2026-10-22", "quotes:api", 1926), row("2026-10-22", "optionchain", 113), row("2026-10-22", "quotes:collector", 1140), row("2026-10-22", "quotes:premium", 5)]);
    const day = days.get("2026-10-22")!;
    expect(day.total).toBe(4988);
    expect(day.byEndpoint.map((entry) => entry.endpoint)).toEqual(["quotes:api", "history", "quotes:collector", "optionchain", "quotes:premium"]);
    expect(day).toMatchObject({ cap: 5000, guard: 4200, overCap: false, overGuard: true });
  });

  it("is over the cap at the cap itself, and over the guard at the guard itself, and not a request below", () => {
    expect(summariseFyersRequests([row("d", "x", 5000)]).get("d")).toMatchObject({ overCap: true, overGuard: true });
    expect(summariseFyersRequests([row("d", "x", 4999)]).get("d")).toMatchObject({ overCap: false, overGuard: true });
    expect(summariseFyersRequests([row("d", "x", 4200)]).get("d")).toMatchObject({ overCap: false, overGuard: true });
    expect(summariseFyersRequests([row("d", "x", 4199)]).get("d")).toMatchObject({ overCap: false, overGuard: false });
  });

  it("adds the same endpoint on one day across rows, and leaves a day with no row out as not recorded", () => {
    const days = summariseFyersRequests([row("2026-10-20", "quotes:api", 4000), row("2026-10-20", "quotes:api", 794)]);
    expect(days.get("2026-10-20")!.byEndpoint).toEqual([{ endpoint: "quotes:api", count: 4794 }]);
    expect(days.has("2026-10-16")).toBe(false);
  });
});

describe("completedRunsExceedSnapshots", () => {
  it("flags an index with fewer than half as many snapshot minutes as completed in-session runs", () => {
    expect(PARTIAL_FAILURE_MIN_RUNS).toBe(5);
    expect(PARTIAL_FAILURE_MAX_SHARE).toBe(0.5);
    expect(completedRunsExceedSnapshots(26, 0)).toBe(true);        // NIFTY50 on 2026-09-30
    expect(completedRunsExceedSnapshots(26, 4)).toBe(true);        // NIFTY50 on 2026-10-05
    expect(completedRunsExceedSnapshots(26, 12)).toBe(true);
    expect(completedRunsExceedSnapshots(26, 13)).toBe(false);      // exactly half is not fewer than half
    expect(completedRunsExceedSnapshots(26, 24)).toBe(false);
  });

  it("says nothing with too few completed runs to compare", () => {
    expect(completedRunsExceedSnapshots(4, 0)).toBe(false);
    expect(completedRunsExceedSnapshots(5, 0)).toBe(true);
  });
});
