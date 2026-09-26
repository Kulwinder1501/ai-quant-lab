import { describe, it, expect } from "vitest";
import { generateCandidates } from "./generate-liquidity-candidates.js";
import type { PersistedCandle } from "../../modules/market-data/domain/candle.js";

/**
 * Phase 1 — Leakage Guard Tests
 *
 * These tests are not about correctness of ICT doctrine.
 * They are about one thing: proving that no candidate has
 * knownAtTime < createdAtTime (i.e. future information is
 * never introduced into the research dataset).
 */

const INSTRUMENT_ID = "test-instrument-uuid";
const SYMBOL = "BANKNIFTY";
const TIMEFRAME = "5m";

function makeCandle(overrides: Partial<PersistedCandle> & { openTime: Date }): PersistedCandle {
  // Destructure so openTime never appears twice in the object literal (TS2783).
  const { openTime, ...rest } = overrides;
  const closeTime = new Date(openTime.getTime() + 5 * 60 * 1000); // +5 minutes
  return {
    id: `candle-${openTime.getTime()}`,
    instrumentId: INSTRUMENT_ID,
    timeframe: TIMEFRAME,
    openTime,
    closeTime,
    open: "50000",
    high: "50100",
    low: "49900",
    close: "50050",
    volume: "1000",
    isComplete: true,
    source: "test",
    ingestionId: null,
    sourceMetadata: {},
    ...rest,
  };
}

/**
 * Builds a synthetic candle series across two IST trading sessions,
 * with a deliberate swing high on day 1 that requires 5 bars to the
 * right before being confirmed.
 */
function buildTwoSessionSeries(): PersistedCandle[] {
  // Day 1: 2026-08-21, Session: 09:15 IST = 03:45 UTC
  const day1Open = new Date("2026-08-21T03:45:00Z");
  const day2Open = new Date("2026-08-22T03:45:00Z");

  const candles: PersistedCandle[] = [];

  // Day 1 — 20 bars. Bar 5 will be the swing high candidate.
  // It needs 5 lower highs to the left AND 5 lower highs to the right
  // before being confirmed. So confirmed at bar index 10.
  for (let i = 0; i < 20; i++) {
    const openTime = new Date(day1Open.getTime() + i * 5 * 60 * 1000);
    const isSwingHighBar = i === 5;
    candles.push(makeCandle({
      openTime,
      high: isSwingHighBar ? "51500" : "50100", // Bar 5 is the swing high peak.
      low: isSwingHighBar ? "50000" : "49900",
    }));
  }

  // Day 2 — 10 bars.
  for (let i = 0; i < 10; i++) {
    const openTime = new Date(day2Open.getTime() + i * 5 * 60 * 1000);
    candles.push(makeCandle({ openTime }));
  }

  return candles;
}

describe("Phase 1 — known_at_time invariant", () => {
  it("never emits a candidate where knownAtTime < createdAtTime", () => {
    const candles = buildTwoSessionSeries();
    const candidates = generateCandidates(candles, INSTRUMENT_ID, SYMBOL, TIMEFRAME, 5);

    for (const c of candidates) {
      expect(c.knownAtTime.getTime()).toBeGreaterThanOrEqual(c.createdAtTime.getTime());
    }
  });

  it("does NOT emit a SWING_HIGH at the pivot bar itself (before right wing closes)", () => {
    const candles = buildTwoSessionSeries();
    const candidates = generateCandidates(candles, INSTRUMENT_ID, SYMBOL, TIMEFRAME, 5);

    const swingHighs = candidates.filter((c) => c.poolType === "SWING_HIGH");
    for (const sh of swingHighs) {
      // The swing high physically occurred at bar 5 of day 1.
      // It must not be emitted until at least 5 bars later (bar 10).
      const pivotBarTime = new Date("2026-08-21T04:10:00Z"); // bar 5 = 03:45 + 5*5min
      if (sh.price === 51500) {
        expect(sh.createdAtTime.toISOString()).toBe(pivotBarTime.toISOString());
        // knownAt must be >= pivot bar + 5 bars = bar 10
        const bar10Time = new Date("2026-08-21T04:35:00Z"); // bar 10 = 03:45 + 10*5min
        expect(sh.knownAtTime.getTime()).toBeGreaterThanOrEqual(bar10Time.getTime());
      }
    }
  });

  it("emits PDH only from day 2 onwards (not day 1, because no prior day exists)", () => {
    const candles = buildTwoSessionSeries();
    const candidates = generateCandidates(candles, INSTRUMENT_ID, SYMBOL, TIMEFRAME, 5);

    const pdhs = candidates.filter((c) => c.poolType === "PDH");
    for (const pdh of pdhs) {
      // All PDH candidates must have knownAtTime on day 2 or later.
      expect(pdh.knownAtTime.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-08-22T03:45:00Z").getTime()
      );
    }
  });

  it("emits both pool types for all expected types", () => {
    const candles = buildTwoSessionSeries();
    const candidates = generateCandidates(candles, INSTRUMENT_ID, SYMBOL, TIMEFRAME, 5);
    const types = new Set(candidates.map((c) => c.poolType));

    // We should have at least session levels and swing levels.
    expect(types.has("SESSION_HIGH")).toBe(true);
    expect(types.has("SESSION_LOW")).toBe(true);
  });

  it("invalidates SESSION_HIGH when a higher high forms in the same session", () => {
    const candles = buildTwoSessionSeries();
    const candidates = generateCandidates(candles, INSTRUMENT_ID, SYMBOL, TIMEFRAME, 5);

    const sessionHighs = candidates.filter((c) => c.poolType === "SESSION_HIGH");

    // Lower session highs should be invalidated (have a non-null invalidatedAtTime).
    const invalidated = sessionHighs.filter((c) => c.invalidatedAtTime !== null);
    expect(invalidated.length).toBeGreaterThan(0);

    // And their invalidation must not happen before they were known.
    for (const c of invalidated) {
      expect(c.invalidatedAtTime!.getTime()).toBeGreaterThanOrEqual(c.knownAtTime.getTime());
    }
  });
});
