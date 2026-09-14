import { describe, expect, it } from "vitest";
import {
  assessBook,
  FRONT_MONTH_INDEX_FUTURE_MAX_SPREAD_FRACTION,
  type AssessBookInput,
} from "./book-coherence.js";

/**
 * The calibrated limit. Measured p50 is 5.76 bps and the widest observed frame 20.42 bps, so the
 * earlier 2 bps here sat below the median and rejected most valid books.
 */
const FUTURES_LIMIT = FRONT_MONTH_INDEX_FUTURE_MAX_SPREAD_FRACTION;

function book(
  bidPrice: number[], askPrice: number[],
  bidQty: number[] = bidPrice.map(() => 30), askQty: number[] = askPrice.map(() => 30),
): AssessBookInput {
  return {
    bid: { price: bidPrice, qty: bidQty, orders: bidPrice.map(() => 1) },
    ask: { price: askPrice, qty: askQty, orders: askPrice.map(() => 1) },
    maximumSpreadFraction: FUTURES_LIMIT,
  };
}

describe("assessBook", () => {
  it("accepts a tight, correctly ordered book", () => {
    const r = assessBook(book([57800.0, 57799.2, 57798.4], [57800.8, 57801.6, 57802.4]));
    expect(r.verdict).toBe("COHERENT");
    expect(r.bestBid).toBe(57800.0);
    expect(r.bestAsk).toBe(57800.8);
    expect(r.spread).toBeCloseTo(0.8, 6);
    expect(r.wasReordered).toBe(false);
  });

  it("sorts unordered ladders into book order and carries sizes with their prices", () => {
    // Bid arrives out of order; the 57800 level has the distinctive size.
    const r = assessBook(book([57798.4, 57800.0, 57799.2], [57802.4, 57800.8, 57801.6],
      [10, 99, 20], [10, 88, 20]));
    expect(r.wasReordered).toBe(true);
    expect(r.bid.price).toEqual([57800.0, 57799.2, 57798.4]);
    expect(r.ask.price).toEqual([57800.8, 57801.6, 57802.4]);
    // The size must follow its own price through the sort, not stay at its old index.
    expect(r.bid.qty[0]).toBe(99);
    expect(r.ask.qty[0]).toBe(88);
    expect(r.verdict).toBe("COHERENT");
  });

  it("accepts a ~32 point gap, which is normal for this instrument and not staleness", () => {
    // Measured against the REST quote endpoint on 2026-09-07: our book matched it exactly and the
    // vendor's own payload reported spread 28.6, so ~5 bps is the real market. An earlier version
    // of this test asserted SPREAD_IMPLAUSIBLE here on a mis-set 2 bps limit.
    const r = assessBook(book([57800.0, 57799.2], [57832.2, 57833.0]));
    expect(r.verdict).toBe("COHERENT");
    expect(r.spread).toBeCloseTo(32.2, 6);
  });

  it("still rejects gross staleness, which is what the limit is actually for", () => {
    // A slot holding a price from minutes earlier lands hundreds of points away: ~35 bps here.
    const r = assessBook(book([57800.0], [58000.0]));
    expect(r.verdict).toBe("SPREAD_IMPLAUSIBLE");
  });

  it("rejects a crossed book, including the exactly-touching case", () => {
    expect(assessBook(book([57801.0], [57800.0])).verdict).toBe("CROSSED");
    expect(assessBook(book([57800.0], [57800.0])).verdict).toBe("CROSSED");
  });

  it("reports EMPTY_SIDE rather than inventing a spread from one side", () => {
    const r = assessBook(book([57800.0], []));
    expect(r.verdict).toBe("EMPTY_SIDE");
    expect(r.spread).toBeNull();
    expect(r.bestAsk).toBeNull();
  });

  it("drops unpopulated zero-filled slots instead of treating them as a level at zero", () => {
    // The vendor arrays are 50 long, zero-filled; only the first entries are real.
    const r = assessBook(book([57800.0, 57799.2, 0, 0], [57800.8, 0, 0, 0]));
    expect(r.bid.price).toEqual([57800.0, 57799.2]);
    expect(r.ask.price).toEqual([57800.8]);
    expect(r.verdict).toBe("COHERENT");
  });

  it("scales the plausibility limit with the instrument, not an absolute point count", () => {
    // The same 32-point gap is fine on a cheap instrument and absurd on an index future.
    const wide = { ...book([500.0], [532.0]), maximumSpreadFraction: 0.10 };
    expect(assessBook(wide).verdict).toBe("COHERENT");
  });

  it("refuses a missing or nonsensical plausibility limit rather than defaulting", () => {
    expect(() => assessBook({ ...book([1], [2]), maximumSpreadFraction: 0 })).toThrow();
    expect(() => assessBook({ ...book([1], [2]), maximumSpreadFraction: Number.NaN })).toThrow();
  });
});
