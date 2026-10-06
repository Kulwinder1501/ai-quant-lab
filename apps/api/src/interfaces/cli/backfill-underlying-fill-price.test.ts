import { describe, expect, it } from "vitest";
import {
  extractQuoteObservedAt,
  resolveBackfillFillPrice,
  MAXIMUM_BACKFILL_TICK_AGE_MS,
  QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS,
  type TickQueryClient,
} from "./backfill-underlying-fill-price.js";

/**
 * Regression coverage for the defect confirmed live on trade
 * `535e5951-56e3-4323-b8af-f47e5f6812c5` (AutoBot-Scalp1m, BANKNIFTY 54900 CE): the original
 * nearest-to-`opened_at` heuristic picked a tick 60 seconds away from the one that actually
 * priced the fill, because it happened to sit closer to `opened_at` on the clock. These tests
 * pin down that `resolveBackfillFillPrice` now prefers the exact `quoteObservedAt`-matched tick,
 * and only falls back to the nearest-tick heuristic when that match is unavailable.
 */

const CONTRACT = {
  underlyingSymbol: "BANKNIFTY",
  expiryDate: new Date("2026-10-27T10:00:00.000Z"),
  strikePrice: 54900,
  optionType: "CE",
};

const OPENED_AT = new Date("2026-10-01T04:05:01.526Z");
const QUOTE_OBSERVED_AT = new Date("2026-10-01T04:04:01.257Z");

/** A query stub that answers each of `resolveBackfillFillPrice`'s two distinct queries. */
function client(overrides: {
  exactRows?: Array<{ underlying_value: string | null }>;
  nearestRows?: Array<{ underlying_value: string | null; age_ms: string | null }>;
} = {}): TickQueryClient {
  return {
    query: async <T,>(text: string): Promise<{ rows: T[] }> => {
      // The exact-match query bounds age with "<= $6"; the nearest-tick fallback has no bound
      // and instead projects age_ms for the caller to check.
      if (text.includes("<= $6")) {
        return { rows: (overrides.exactRows ?? []) as T[] };
      }
      return { rows: (overrides.nearestRows ?? []) as T[] };
    },
  };
}

describe("extractQuoteObservedAt", () => {
  it("reads fee_breakdown.entryChecks.quoteObservedAt", () => {
    const result = extractQuoteObservedAt({
      entryChecks: { quoteObservedAt: "2026-10-01T04:04:01.257Z" },
    });
    expect(result?.toISOString()).toBe("2026-10-01T04:04:01.257Z");
  });

  it("returns null when fee_breakdown is null", () => {
    expect(extractQuoteObservedAt(null)).toBeNull();
  });

  it("returns null when entryChecks is missing", () => {
    expect(extractQuoteObservedAt({})).toBeNull();
  });

  it("returns null when quoteObservedAt is not a parseable date", () => {
    expect(extractQuoteObservedAt({ entryChecks: { quoteObservedAt: "not-a-date" } })).toBeNull();
    expect(extractQuoteObservedAt({ entryChecks: { quoteObservedAt: 12345 } })).toBeNull();
  });
});

describe("resolveBackfillFillPrice - quoteObservedAt-match path", () => {
  it("prefers the tick matching quoteObservedAt over a nearer-to-opened_at one", async () => {
    // Reproduces 535e5951: the exact tick reads 54862.45; a nearer-to-opened_at tick (which the
    // nearest-tick stub returns here) reads the wrong 54793.85, and must not win.
    const db = client({
      exactRows: [{ underlying_value: "54862.45" }],
      nearestRows: [{ underlying_value: "54793.85", age_ms: "255" }],
    });

    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, QUOTE_OBSERVED_AT);

    expect(result).toEqual({ value: 54862.45, source: "BACKFILLED_FROM_QUOTE_OBSERVED_AT" });
  });

  it("accepts a quoteObservedAt match within the tolerance window", async () => {
    const db = client({ exactRows: [{ underlying_value: "54862.45" }] });
    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, QUOTE_OBSERVED_AT);
    expect(result?.source).toBe("BACKFILLED_FROM_QUOTE_OBSERVED_AT");
    // Sanity: the tolerance used is the documented constant, not an ad hoc number.
    expect(QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS).toBe(500);
  });
});

describe("resolveBackfillFillPrice - nearest-tick fallback path", () => {
  it("falls back to the nearest tick when quoteObservedAt is null (pre-field historical trade)", async () => {
    const db = client({ nearestRows: [{ underlying_value: "54793.85", age_ms: "60255" }] });

    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, null);

    expect(result).toEqual({ value: 54793.85, source: "BACKFILLED_NEAREST_TICK" });
  });

  it("falls back to the nearest tick when nothing matches quoteObservedAt within tolerance", async () => {
    const db = client({
      exactRows: [], // no tick within QUOTE_OBSERVED_AT_MATCH_TOLERANCE_MS of quoteObservedAt
      nearestRows: [{ underlying_value: "54793.85", age_ms: "60255" }],
    });

    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, QUOTE_OBSERVED_AT);

    expect(result).toEqual({ value: 54793.85, source: "BACKFILLED_NEAREST_TICK" });
  });

  it("refuses the nearest tick when it exceeds MAXIMUM_BACKFILL_TICK_AGE_MS", async () => {
    const db = client({
      nearestRows: [{
        underlying_value: "54793.85",
        age_ms: String(MAXIMUM_BACKFILL_TICK_AGE_MS + 1),
      }],
    });

    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, null);

    expect(result).toBeNull();
  });

  it("returns null when no tick exists at all for the contract", async () => {
    const db = client();
    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, null);
    expect(result).toBeNull();
  });

  it("returns null when the only nearby tick has a non-numeric underlying_value", async () => {
    const db = client({ nearestRows: [{ underlying_value: null, age_ms: "100" }] });
    const result = await resolveBackfillFillPrice(db, CONTRACT, OPENED_AT, null);
    expect(result).toBeNull();
  });
});
