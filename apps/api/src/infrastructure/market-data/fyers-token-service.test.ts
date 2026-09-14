import { describe, expect, it, vi } from "vitest";
import {
  FYERS_PROVIDER_ID,
  FyersRefreshError,
  FyersTokenService,
  isRetryableRefreshFailure,
  peerRefreshWaitMs,
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
  it("waits seconds, growing, because a caller needing a token waits this out", () => {
    expect(refreshRetryDelayMs(1)).toBe(2_000);
    expect(refreshRetryDelayMs(2)).toBe(6_000);
  });

  it("treats a non-positive attempt as the first", () => {
    expect(refreshRetryDelayMs(0)).toBe(2_000);
  });
});

describe("peerRefreshWaitMs", () => {
  it("covers every attempt the winner may take plus every gap between them", () => {
    // 3 x 5s of HTTP allowance, plus the 2s and 6s backoffs.
    expect(peerRefreshWaitMs(3)).toBe(23_000);
    expect(peerRefreshWaitMs(1)).toBe(5_000);
  });
});

/**
 * A pool stub that models the two locks that matter: `FOR UPDATE` on the credential row, and
 * the session advisory lock the refresh path uses instead.
 *
 * It exists so a test can ask what was held at a given moment. `rowLockHeld()` is the
 * regression surface -- the shape this file replaced took `FOR UPDATE` and then slept inside
 * it, and nothing short of modelling the lock catches that coming back.
 */
function lockingPool(row: Record<string, unknown>) {
  const queries: string[] = [];
  let nextClientId = 1;
  let rowLockOwner: number | null = null;
  let advisoryOwner: number | null = null;
  const openTransactions = new Set<number>();

  const connect = async () => {
    const id = nextClientId;
    nextClientId += 1;
    return {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push(sql.trim().split("\n")[0]!.trim());
        if (sql.startsWith("BEGIN")) { openTransactions.add(id); return { rows: [] }; }
        if (sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
          openTransactions.delete(id);
          if (rowLockOwner === id) rowLockOwner = null;
          return { rows: [] };
        }
        if (sql.includes("pg_try_advisory_lock")) {
          if (advisoryOwner !== null) return { rows: [{ locked: false }] };
          advisoryOwner = id;
          return { rows: [{ locked: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          if (advisoryOwner === id) advisoryOwner = null;
          return { rows: [] };
        }
        if (sql.includes("SELECT access_token")) {
          if (sql.includes("FOR UPDATE")) {
            if (rowLockOwner !== null && rowLockOwner !== id) {
              // A real `FOR UPDATE` waits here. A test that reaches this never finishes,
              // which is precisely the production symptom.
              await new Promise(() => undefined);
            }
            rowLockOwner = id;
          }
          return { rows: [{ ...row }] };
        }
        if (sql.startsWith("UPDATE provider_credentials") && sql.includes("access_token = $2")) {
          row.access_token = parameters?.[1];
          row.access_token_expires_at = parameters?.[2];
          row.last_error = null;
        }
        if (sql.includes("last_error = $2")) row.last_error = parameters?.[1];
        return { rows: [] };
      },
      release: () => undefined,
    };
  };

  const pool = {
    connect,
    query: async (sql: string, parameters?: unknown[]) => {
      const client = await connect();
      return client.query(sql, parameters);
    },
  };

  return {
    pool: pool as never,
    queries,
    row,
    /** True while any client holds `FOR UPDATE` on the credential row. */
    rowLockHeld: () => rowLockOwner !== null,
    /** True while any client has an uncommitted transaction open. */
    transactionOpen: () => openTransactions.size > 0,
    /** Pretend a different process already holds the refresh advisory lock. */
    holdRefreshLock: () => { advisoryOwner = -1; },
  };
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

function success(token = "fresh-token") {
  return new Response(JSON.stringify({ s: "ok", access_token: token }), { status: 200 });
}

function build(fetchImpl: typeof fetch, sleeps: number[], attempts = 3) {
  const { pool } = lockingPool(expiredCredential());
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
    // Bounded: ~8 seconds total, because a caller that needs a token waits this out.
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
    const { pool } = lockingPool({
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

/**
 * The 2026-08-25 incident: the access token expired overnight, every refresh came back code
 * -16, and the retry backed off while still holding `FOR UPDATE` on the credential row. The
 * scheduler container logged 206 missed cron executions, stalled ~22 minutes, and its
 * hour-restricted schedules never fired again until it was restarted.
 */
describe("FyersTokenService refresh concurrency", () => {
  const credentials = { appId: "APPID-100", appSecret: "secret", pin: "1234" };

  it("holds no row lock and no open transaction while a retry sleeps", async () => {
    const shared = lockingPool(expiredCredential());
    const observed: { rowLocked: boolean; transactionOpen: boolean }[] = [];
    let calls = 0;
    const service = new FyersTokenService({
      ...credentials,
      pool: shared.pool,
      refreshAttempts: 3,
      fetch: (async () => {
        calls += 1;
        return calls === 1 ? refusal(-16, "Refresh token API is currently disabled.") : success();
      }) as never,
      sleep: async () => {
        observed.push({
          rowLocked: shared.rowLockHeld(),
          transactionOpen: shared.transactionOpen(),
        });
      },
    });

    await expect(service.getAccessToken()).resolves.toBe("fresh-token");

    expect(observed).toEqual([{ rowLocked: false, transactionOpen: false }]);
    // Belt and braces: the refresh path must not reach for the row lock at all.
    expect(shared.queries.some((sql) => sql.includes("FOR UPDATE"))).toBe(false);
  });

  it("collapses two concurrent callers in one process onto a single refresh", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => { calls += 1; return success(); }, sleeps);

    const tokens = await Promise.all([service.getAccessToken(), service.getAccessToken()]);

    expect(calls).toBe(1);
    expect(tokens).toEqual(["fresh-token", "fresh-token"]);
  });

  it("does not cache the failure: a later caller gets its own attempt", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const service = build(async () => { calls += 1; return refusal(-16, "disabled"); }, sleeps, 1);

    await expect(service.getAccessToken()).rejects.toThrow(/code -16/);
    await expect(service.getAccessToken()).rejects.toThrow(/code -16/);
    expect(calls).toBe(2);
  });

  it("lets a second process through while the first is backing off, without refreshing twice", async () => {
    const shared = lockingPool(expiredCredential());
    let winnerCalls = 0;
    let loserCalls = 0;
    let winnerReachedBackoff!: () => void;
    let releaseWinner!: () => void;
    const reachedBackoff = new Promise<void>((resolve) => { winnerReachedBackoff = resolve; });
    const mayResume = new Promise<void>((resolve) => { releaseWinner = resolve; });

    const winner = new FyersTokenService({
      ...credentials,
      pool: shared.pool,
      refreshAttempts: 3,
      fetch: (async () => {
        winnerCalls += 1;
        return winnerCalls === 1 ? refusal(-16, "disabled") : success();
      }) as never,
      sleep: async () => { winnerReachedBackoff(); await mayResume; },
    });
    const loser = new FyersTokenService({
      ...credentials,
      pool: shared.pool,
      refreshAttempts: 3,
      fetch: (async () => { loserCalls += 1; return success("loser-token"); }) as never,
      // Each poll unblocks the winner and yields a macrotask, so the winner's second attempt
      // lands within the poll budget rather than the test depending on one exact turn.
      sleep: async () => {
        releaseWinner();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      },
    });

    const winnerToken = winner.getAccessToken();
    await reachedBackoff;

    // The winner is asleep mid-retry. Nothing it holds may stop the second process.
    expect(shared.rowLockHeld()).toBe(false);
    expect(shared.transactionOpen()).toBe(false);

    await expect(loser.getAccessToken()).resolves.toBe("fresh-token");
    await expect(winnerToken).resolves.toBe("fresh-token");
    expect(winnerCalls).toBe(2);
    // The second process waited for the winner's token instead of burning a refresh of its own.
    expect(loserCalls).toBe(0);
  });

  it("gives up rather than waiting forever on a peer that never publishes a token", async () => {
    const shared = lockingPool(expiredCredential());
    shared.holdRefreshLock();
    const sleeps: number[] = [];
    const fetchSpy = vi.fn();
    const service = new FyersTokenService({
      ...credentials,
      pool: shared.pool,
      refreshAttempts: 3,
      fetch: fetchSpy as never,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(service.getAccessToken()).rejects.toThrow(/without publishing a token/);

    expect(fetchSpy).not.toHaveBeenCalled();
    // Polls only as long as the winner's own budget, then reports rather than hanging.
    expect(sleeps).toHaveLength(peerRefreshWaitMs(3) / 1_000);
  });
});

describe("FyersTokenService interactive authentication status", () => {
  it("records a redacted login failure without clearing an older usable token", async () => {
    // Declared with its parameters so `query.mock.calls[0]` is a two-element tuple; an
    // argument-less mock types the call as `[]` and the destructuring below cannot compile.
    const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({ rows: [] }));
    const service = new FyersTokenService({
      pool: { query } as never,
      appId: "APPID-100",
      appSecret: "secret",
      pin: "1234",
    });
    const echoedSecret = "a".repeat(48);

    await service.recordAuthenticationFailure(`Exchange failed: ${echoedSecret}`);

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("last_error = EXCLUDED.last_error");
    expect(sql).not.toContain("access_token = NULL");
    expect(parameters).toEqual([FYERS_PROVIDER_ID, "Exchange failed: <redacted>"]);
  });
});
