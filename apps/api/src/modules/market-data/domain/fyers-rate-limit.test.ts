import { describe, expect, it } from "vitest";
import {
  FYERS_REST_JOB_TYPES,
  FyersRateLimitGate,
  FyersRateLimitedError,
  classifyFyersRateLimit,
  classifyFyersRateLimitFromText,
  isFyersRateLimitedError,
  rateLimitCooldownMs,
} from "./fyers-rate-limit.js";

describe("classifyFyersRateLimit", () => {
  // The three messages Fyers returned on 2026-10-16.
  it("tells the three limits apart from the provider's own text", () => {
    expect(classifyFyersRateLimit({ status: 429, code: -360, message: "You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime" })).toBe("DAILY");
    expect(classifyFyersRateLimit({ status: 429, code: -360, message: "You've reached the Standard plan limit of 50 requests/minute." })).toBe("PER_MINUTE");
    expect(classifyFyersRateLimit({ status: 429, code: -360, message: "You've reached the Standard plan limit of 5 requests/second." })).toBe("PER_SECOND");
  });

  it("calls a 429 with no explanation UNKNOWN, so it keeps the old retry behaviour", () => {
    expect(classifyFyersRateLimit({ status: 429, code: null, message: "No quote rows returned." })).toBe("UNKNOWN");
    expect(classifyFyersRateLimit({ status: 200, code: 429 })).toBe("UNKNOWN");
  });

  it("returns null for anything that is not a rate limit", () => {
    expect(classifyFyersRateLimit({ status: 200 })).toBeNull();
    expect(classifyFyersRateLimit({ status: 500, message: "boom" })).toBeNull();
    expect(classifyFyersRateLimit({ status: 401, code: -16, message: "token" })).toBeNull();
  });

  it("reads the limit out of an error message that already carries it", () => {
    expect(classifyFyersRateLimitFromText("Fyers quote request failed with HTTP 429, code -360. You've reached the Standard plan limit of 5,000 requests/day.")).toBe("DAILY");
    expect(classifyFyersRateLimitFromText("TypeError: fetch failed")).toBeNull();
  });
});

describe("rateLimitCooldownMs", () => {
  it("waits just over a second, about a minute, or a re-probe interval", () => {
    const now = Date.UTC(2026, 9, 16, 5, 34); // 11:04 IST
    expect(rateLimitCooldownMs("PER_SECOND", now)).toBe(1_100);
    expect(rateLimitCooldownMs("PER_MINUTE", now)).toBe(65_000);
    expect(rateLimitCooldownMs("UNKNOWN", now)).toBe(30_000);
    expect(rateLimitCooldownMs("DAILY", now)).toBe(15 * 60_000);
  });

  it("does not wait past the quota reset: a daily cooldown near midnight IST ends a minute after it", () => {
    const tenToMidnightIst = Date.UTC(2026, 9, 16, 18, 20); // 23:50 IST
    expect(rateLimitCooldownMs("DAILY", tenToMidnightIst)).toBe(10 * 60_000 + 60_000);
  });
});

describe("FyersRateLimitGate", () => {
  it("fails fast, without a request, for the length of the cooldown, then opens again", () => {
    let now = Date.UTC(2026, 9, 16, 5, 34);
    const gate = new FyersRateLimitGate(() => now);
    expect(() => gate.assertOpen()).not.toThrow();

    gate.open("PER_MINUTE");
    expect(() => gate.assertOpen()).toThrow(FyersRateLimitedError);
    now += 64_000;
    expect(gate.state().blocked).toBe(true);
    now += 2_000;
    expect(gate.state().blocked).toBe(false);
    expect(() => gate.assertOpen()).not.toThrow();
  });

  it("never lets a short limit shorten a longer one", () => {
    let now = Date.UTC(2026, 9, 16, 5, 34);
    const gate = new FyersRateLimitGate(() => now);
    gate.open("DAILY");
    gate.open("PER_SECOND");
    now += 60_000;
    const state = gate.state();
    expect(state.blocked && state.kind).toBe("DAILY");
  });

  it("carries the kind and retry time on the error it throws", () => {
    const gate = new FyersRateLimitGate(() => 1_000_000);
    gate.open("DAILY");
    try {
      gate.assertOpen();
      throw new Error("should have thrown");
    } catch (error) {
      expect(isFyersRateLimitedError(error)).toBe(true);
      expect((error as FyersRateLimitedError).kind).toBe("DAILY");
      expect((error as FyersRateLimitedError).retryAtMs).toBeGreaterThan(1_000_000);
    }
  });
});

describe("FYERS_REST_JOB_TYPES", () => {
  it("lists the polling jobs and leaves the exit sweep out, which must keep running", () => {
    expect(FYERS_REST_JOB_TYPES.has("OPTION_PREMIUM_TICKS")).toBe(true);
    expect(FYERS_REST_JOB_TYPES.has("INDICES_INTRADAY")).toBe(true);
    expect(FYERS_REST_JOB_TYPES.has("PAPER_TRADE_EXIT_SWEEP")).toBe(false);
  });
});
