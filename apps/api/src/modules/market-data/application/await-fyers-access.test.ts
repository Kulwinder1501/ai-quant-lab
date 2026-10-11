import { describe, expect, it } from "vitest";
import { awaitFyersAccess } from "./await-fyers-access.js";

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

describe("awaitFyersAccess", () => {
  it("returns immediately when a token is available", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await awaitFyersAccess(async () => { calls += 1; return "token"; }, {
      maxWaitMs: 45 * 60_000, pollIntervalMs: 3 * 60_000, ...clock,
    });
    expect(result).toEqual({ available: true, attempts: 1 });
    expect(calls).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it("waits through a refusal and succeeds once Fyers recovers", async () => {
    const clock = fakeClock();
    let calls = 0;
    const retries: string[] = [];
    const result = await awaitFyersAccess(async () => {
      calls += 1;
      if (calls < 4) throw new Error("Fyers token refresh failed (HTTP 400, code -16).");
      return "token";
    }, {
      maxWaitMs: 45 * 60_000, pollIntervalMs: 3 * 60_000, ...clock,
      onRetry: (attempt, error) => retries.push(`${attempt}:${error}`),
    });
    expect(result).toEqual({ available: true, attempts: 4 });
    expect(clock.now()).toBe(9 * 60_000);
    expect(retries).toHaveLength(3);
  });

  it("gives up after the deadline and reports the last error", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await awaitFyersAccess(async () => {
      calls += 1;
      throw new Error(`still refused #${calls}`);
    }, { maxWaitMs: 10 * 60_000, pollIntervalMs: 3 * 60_000, ...clock });
    expect(result.available).toBe(false);
    expect(result.attempts).toBe(calls);
    expect(result.lastError).toBe(`still refused #${calls}`);
    expect(clock.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it("makes exactly one attempt when the wait budget is smaller than one poll", async () => {
    const clock = fakeClock();
    const result = await awaitFyersAccess(async () => { throw new Error("refused"); }, {
      maxWaitMs: 1_000, pollIntervalMs: 60_000, ...clock,
    });
    expect(result).toEqual({ available: false, attempts: 1, lastError: "refused" });
    expect(clock.now()).toBe(0);
  });

  it("stringifies a non-Error rejection", async () => {
    const clock = fakeClock();
    const result = await awaitFyersAccess(async () => { throw "plain string"; }, {
      maxWaitMs: 1_000, pollIntervalMs: 60_000, ...clock,
    });
    expect(result.lastError).toBe("plain string");
  });
});
