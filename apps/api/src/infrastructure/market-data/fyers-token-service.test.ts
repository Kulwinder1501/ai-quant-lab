import { describe, expect, it, vi } from "vitest";
import {
  FyersRefreshError,
  FyersTokenService,
  isRetryableRefreshFailure,
  refreshRetryDelayMs,
} from "./fyers-token-service.js";

describe("isRetryableRefreshFailure", () => {
  it("retries code -16, the refusal that recovered on its own", () => {
    // 2026-08-05: "Refresh token API is currently disabled to comply with SEBI regulations",
    // which reads permanent. A refresh succeeded 19 minutes later.
    expect(isRetryableRefreshFailure({ code: -16, httpStatus: 400, networkError: false })).toBe(true);
  });

  it("retries rate limits and server faults", () => {
    expect(isRetryableRefreshFailure({ code: null, httpStatus: 429, networkError: false })).toBe(true);
    expect(isRetryableRefreshFailure({ code: null, httpStatus: 500, networkError: false })).toBe(true);
    expect(isRetryableRefreshFailure({ code: null, httpStatus: 503, networkError: false })).toBe(true);
  });

  it("retries a request that never reached the provider", () => {
    expect(isRetryableRefreshFailure({ code: null, httpStatus: null, networkError: true })).toBe(true);
  });

  // Retrying a terminal failure spends the budget a real blip needs, and the provider answers
  // 429 after about a dozen rapid calls -- so an unrecognised code is treated as terminal.
  it("does not retry a configuration fault or an unrecognised code", () => {
    expect(isRetryableRefreshFailure({ code: -371, httpStatus: 400, networkError: false })).toBe(false);
    expect(isRetryableRefreshFailure({ code: -99, httpStatus: 400, networkError: false })).toBe(false);
    expect(isRetryableRefreshFailure({ code: null, httpStatus: 401, networkError: false })).toBe(false);
  });
});

describe("refreshRetryDelayMs", () => {
  it("waits seconds, growing, because the row stays locked throughout", () => {
    expect(refreshRetryDelayMs(1)).toBe(2_000);
    expect(refreshRetryDelayMs(2)).toBe(6_000);
  });

  it("treats a non-positive attempt as the first", () => {
    expect(refreshRetryDelayMs(0)).toBe(2_000);
  });
});

/**
 * A pool stub that answers the credential query and records writes.
 *
 * The real transaction takes `FOR UPDATE`; nothing here models locking, so these tests cover
 * the retry decision rather than the concurrency it is bounded for.
 */
function fakePool(row: Record<string, unknown>) {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("SELECT access_token")) return { rows: [row] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

function expiredCredential() {
  return {
    access_token: "stale",
    access_token_expires_at: new Date(Date.now() - 60_000),
    refresh_token: "refresh-me",
    refresh_token_expires_at: new Date(Date.now() + 10 * 24 * 60 * 60_000),
  };
}

function refusal(code: number, message: string) {
  return new Response(JSON.stringify({ s: "error", code, message }), { status: 400 });
}

function success() {
  return new Response(JSON.stringify({ s: "ok", access_token: "fresh-token" }), { status: 200 });
}

function build(fetchImpl: typeof fetch, sleeps: number[], attempts = 3) {
  const { pool } = fakePool(expiredCredential());
  return new FyersTokenService({
    pool,
    appId: "APPID-100",
    appSecret: "secret",
    pin: "1234",
    fetch: fetchImpl,
    refreshAttempts: attempts,
    sleep: async (ms) => { sleeps.push(ms); },
  });
}

describe("FyersTokenService refresh retry", () => {
  it("recovers when a refusal clears on a later attempt", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => {
      calls += 1;
      return calls === 1
        ? refusal(-16, "Refresh token API is currently disabled to comply with SEBI regulations.")
        : success();
    }, sleeps);

    await expect(service.getAccessToken()).resolves.toBe("fresh-token");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("gives up after the budget and says how many attempts were made", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => {
      calls += 1;
      return refusal(-16, "Refresh token API is currently disabled.");
    }, sleeps);

    await expect(service.getAccessToken()).rejects.toThrow(/Retried 3 times without success/);
    expect(calls).toBe(3);
    // Bounded: ~8 seconds total, because the credential row is locked while this runs.
    expect(sleeps).toEqual([2_000, 6_000]);
  });

  it("does not retry a terminal failure", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => {
      calls += 1;
      return refusal(-371, "invalid appIdHash");
    }, sleeps);

    await expect(service.getAccessToken()).rejects.toThrow(/appIdHash/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a request that threw before reaching the provider", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return success();
    }, sleeps);

    await expect(service.getAccessToken()).resolves.toBe("fresh-token");
    expect(calls).toBe(2);
  });

  it("carries the retryable classification on the thrown error", async () => {
    const service = build(async () => refusal(-16, "disabled"), [], 1);

    await service.getAccessToken().catch((error: unknown) => {
      expect(error).toBeInstanceOf(FyersRefreshError);
      expect((error as FyersRefreshError).retryable).toBe(true);
      expect((error as FyersRefreshError).code).toBe(-16);
    });
  });

  it("makes exactly one attempt when the budget is one", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => { calls += 1; return refusal(-16, "disabled"); }, sleeps, 1);

    await expect(service.getAccessToken()).rejects.toThrow(/code -16/);
    expect(calls).toBe(1);
    // A single-attempt failure must not claim it was retried.
    expect(sleeps).toEqual([]);
  });

  it("does not refresh at all while the access token is still good", async () => {
    const { pool } = fakePool({
      access_token: "still-valid",
      access_token_expires_at: new Date(Date.now() + 60 * 60_000),
      refresh_token: "refresh-me",
      refresh_token_expires_at: new Date(Date.now() + 10 * 24 * 60 * 60_000),
    });
    const fetchSpy = vi.fn();
    const service = new FyersTokenService({
      pool, appId: "APPID-100", appSecret: "secret", pin: "1234",
      fetch: fetchSpy as never, sleep: async () => undefined,
    });

    await expect(service.getAccessToken()).resolves.toBe("still-valid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
