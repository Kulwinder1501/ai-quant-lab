import { describe, expect, it } from "vitest";
import type { AtmImpliedVolatilityResult } from "../../market-data/domain/atm-implied-volatility.js";
import {
  MAXIMUM_CHAIN_SNAPSHOT_AGE_MINUTES,
  selectStraddleImpliedVolatility,
} from "./straddle-implied-volatility.js";

const NOW = new Date("2026-09-10T05:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const CHAIN_IV: AtmImpliedVolatilityResult = {
  measurable: true, impliedVolatility: 0.121, atmStrike: 24_000, impliedForward: 24_010, daysToExpiry: 6,
};

describe("selectStraddleImpliedVolatility", () => {
  it("prefers the chain's own ATM IV at the contract's expiry over India VIX", () => {
    const result = selectStraddleImpliedVolatility({
      chain: CHAIN_IV, chainObservedAt: minutesAgo(3), now: NOW, vix: 0.135, daysToExpiry: 6,
    });

    expect(result).toMatchObject({ impliedVolatility: 0.121, source: "CHAIN_ATM_AT_EXPIRY", tenorWarning: null });
    expect(result?.observedAt).toEqual(minutesAgo(3));
  });

  it("falls back to VIX with an explicit source tag and tenor warning when no chain IV is solvable", () => {
    const result = selectStraddleImpliedVolatility({
      chain: { measurable: false, reason: "NO_PARITY_FORWARD", explanation: "x" },
      chainObservedAt: minutesAgo(3), now: NOW, vix: 0.135, daysToExpiry: 6,
    });

    expect(result).toMatchObject({ impliedVolatility: 0.135, source: "INDIA_VIX_30D_PRIOR_CLOSE", observedAt: null });
    expect(result?.tenorWarning).toMatch(/30-day/);
    expect(result?.tenorWarning).toMatch(/PRIOR daily close/);
    expect(result?.tenorWarning).toMatch(/6-day contract/);
  });

  it("treats a stale snapshot as missing rather than pricing off it", () => {
    const stale = selectStraddleImpliedVolatility({
      chain: CHAIN_IV, chainObservedAt: minutesAgo(MAXIMUM_CHAIN_SNAPSHOT_AGE_MINUTES + 1), now: NOW,
      vix: 0.135, daysToExpiry: 6,
    });
    const edge = selectStraddleImpliedVolatility({
      chain: CHAIN_IV, chainObservedAt: minutesAgo(MAXIMUM_CHAIN_SNAPSHOT_AGE_MINUTES), now: NOW,
      vix: 0.135, daysToExpiry: 6,
    });

    expect(stale?.source).toBe("INDIA_VIX_30D_PRIOR_CLOSE");
    expect(edge?.source).toBe("CHAIN_ATM_AT_EXPIRY");
  });

  it("rejects a snapshot observed after `now` (not point-in-time)", () => {
    const result = selectStraddleImpliedVolatility({
      chain: CHAIN_IV, chainObservedAt: new Date(NOW.getTime() + 60_000), now: NOW, vix: null, daysToExpiry: 6,
    });
    expect(result).toBeNull();
  });

  it("returns null when neither source exists, instead of inventing a number", () => {
    expect(selectStraddleImpliedVolatility({
      chain: null, chainObservedAt: null, now: NOW, vix: null, daysToExpiry: 6,
    })).toBeNull();
  });
});
