import { describe, expect, it } from "vitest";
import { DepthBookAssembler, DEPTH_BOOK_LEVELS } from "./depth-book-assembler.js";
import { assessBook } from "./book-coherence.js";

/** A protobuf MarketLevel: scalars arrive inside `{ value }` wrappers. */
function level(num: number, price: number, qty = 30, nord = 1) {
  return { num: { value: num }, price: { value: price }, qty: { value: qty }, nord: { value: nord } };
}

/** A full, correctly ordered 50-level book, as a snapshot delivers. */
function fullSnapshot() {
  return {
    bids: Array.from({ length: DEPTH_BOOK_LEVELS }, (_, i) => level(i, 57800 - i * 0.8)),
    asks: Array.from({ length: DEPTH_BOOK_LEVELS }, (_, i) => level(i, 57800.8 + i * 0.8)),
  };
}

const FUTURES_LIMIT = 0.0002;

describe("DepthBookAssembler", () => {
  it("places each level at its own num, not its arrival index", () => {
    const a = new DepthBookAssembler();
    // Arrives in scrambled order: the level for slot 2 comes first. Keying by arrival index -- the
    // vendor SDK's defect -- would put 57798.4 at the touch.
    const book = a.apply("X", {
      bids: [level(2, 57798.4), level(0, 57800.0), level(1, 57799.2)],
      asks: [level(1, 57801.6), level(0, 57800.8)],
    }, true);

    expect(book.bidPrice.slice(0, 3)).toEqual([57800.0, 57799.2, 57798.4]);
    expect(book.askPrice.slice(0, 2)).toEqual([57800.8, 57801.6]);
    expect(book.appliedBidLevels).toBe(3);
    expect(book.droppedLevels).toBe(0);
  });

  it("carries qty and orders to the same slot as their price", () => {
    const a = new DepthBookAssembler();
    const book = a.apply("X", { bids: [level(3, 57797.6, 99, 7)], asks: [] }, true);
    expect(book.bidPrice[3]).toBe(57797.6);
    expect(book.bidQty[3]).toBe(99);
    expect(book.bidOrders[3]).toBe(7);
  });

  it("leaves slots a sparse update does not mention untouched", () => {
    const a = new DepthBookAssembler();
    a.apply("X", fullSnapshot(), true);
    // A 1-level delta, which is the normal case: measured 7 levels on a 50-level book.
    const after = a.apply("X", { bids: [level(0, 57801.0, 55)], asks: [] }, false);
    expect(after.bidPrice[0]).toBe(57801.0);
    expect(after.bidQty[0]).toBe(55);
    // Slot 1 still holds its snapshot value rather than being zeroed or shifted.
    expect(after.bidPrice[1]).toBeCloseTo(57799.2, 6);
    expect(after.appliedBidLevels).toBe(1);
  });

  it("clears the book on a snapshot so a re-base actually re-bases", () => {
    const a = new DepthBookAssembler();
    a.apply("X", fullSnapshot(), true);
    // A snapshot mentioning only two levels must leave the other 48 empty, not stale. This is the
    // half the vendor SDK omits entirely.
    const rebased = a.apply("X", {
      bids: [level(0, 100.0)], asks: [level(0, 101.0)],
    }, true);
    expect(rebased.bidPrice[0]).toBe(100.0);
    expect(rebased.bidPrice[1]).toBe(0);
    expect(rebased.bidPrice.filter((p) => p > 0)).toHaveLength(1);
  });

  it("treats a price present and non-positive as an emptied slot, clearing its size too", () => {
    const a = new DepthBookAssembler();
    a.apply("X", fullSnapshot(), true);
    const after = a.apply("X", { bids: [level(0, 0, 0, 0)], asks: [] }, false);
    expect(after.bidPrice[0]).toBe(0);
    expect(after.bidQty[0]).toBe(0);
    expect(after.bidOrders[0]).toBe(0);
  });

  /*
   * Two vendor encodings observed live on 2026-09-07, neither of which the first version of this
   * module handled. Both silently produced an all-zero book, so they are pinned here.
   */
  it("keeps the existing price when a delta carries size only", () => {
    const a = new DepthBookAssembler();
    a.apply("X", fullSnapshot(), true);
    // The real shape: { qty, nord, num } with no price field at all.
    const after = a.apply("X", {
      bids: [{ num: { value: 0 }, qty: { value: 90 }, nord: { value: 3 } }],
      asks: [],
    }, false);
    expect(after.bidPrice[0]).toBe(57800.0); // unchanged, not wiped
    expect(after.bidQty[0]).toBe(90);
    expect(after.bidOrders[0]).toBe(3);
  });

  it("reads an empty wrapper as the protobuf default, so num:{} means level 0", () => {
    const a = new DepthBookAssembler();
    // `num: {}` is how a UInt32Value of 0 arrives -- protobuf omits a default-valued field.
    // Reading it as absent dropped every top-of-book update.
    const book = a.apply("X", {
      bids: [{ num: {}, price: { value: "5745020" }, qty: { value: 30 } }],
      asks: [],
    }, true);
    expect(book.droppedLevels).toBe(0);
    expect(book.appliedBidLevels).toBe(1);
    expect(book.bidPrice[0]).toBe(5745020); // paise; the streamer divides by 100
    expect(book.bidQty[0]).toBe(30);
  });

  it("coerces string-encoded prices", () => {
    const a = new DepthBookAssembler();
    const book = a.apply("X", {
      bids: [{ num: { value: 1 }, price: { value: "5745020" }, qty: { value: 30 } }], asks: [],
    }, true);
    expect(book.bidPrice[1]).toBe(5745020);
  });

  it("reads a protobuf Long price, which is an object that only looks like a string", () => {
    // `price` is an Int64Value, and protobuf.js decodes 64-bit ints to a Long. It renders as
    // "5744000" under JSON.stringify -- which is precisely why a log makes it look like a string.
    // A coercion that handled numbers and strings only produced an all-zero book from live data.
    const long = { low: 5744000, high: 0, unsigned: false, toString: () => "5744000" };
    const a = new DepthBookAssembler();
    const book = a.apply("X", {
      bids: [{ num: {}, price: { value: long }, qty: { value: 60 } }], asks: [],
    }, true);
    expect(book.bidPrice[0]).toBe(5744000);
    expect(book.bidQty[0]).toBe(60);
    expect(book.droppedLevels).toBe(0);
  });

  it("does not mistake a plain object for a Long", () => {
    const a = new DepthBookAssembler();
    // "[object Object]" is not finite, so this must be treated as no usable price, leaving the
    // slot's existing price alone rather than writing NaN into the book.
    a.apply("X", fullSnapshot(), true);
    const after = a.apply("X", { bids: [{ num: { value: 0 }, price: { value: {} } }], asks: [] }, false);
    expect(after.bidPrice[0]).toBe(57800.0);
    expect(Number.isNaN(after.bidPrice[0])).toBe(false);
  });

  it("drops a level whose num is missing or out of range rather than guessing a slot", () => {
    const a = new DepthBookAssembler();
    const book = a.apply("X", {
      bids: [
        { price: { value: 57800 }, qty: { value: 30 } }, // no num
        level(DEPTH_BOOK_LEVELS, 57799),                  // out of range
        level(-1, 57798),                                 // negative
        level(0, 57801),                                  // the only placeable one
      ],
      asks: [],
    }, true);
    expect(book.droppedLevels).toBe(3);
    expect(book.appliedBidLevels).toBe(1);
    expect(book.bidPrice[0]).toBe(57801);
  });

  it("does not hand out a reference that later messages mutate", () => {
    const a = new DepthBookAssembler();
    const first = a.apply("X", { bids: [level(0, 57800)], asks: [] }, true);
    a.apply("X", { bids: [level(0, 57900)], asks: [] }, false);
    // The vendor object's reuse is exactly what corrupts a buffered frame.
    expect(first.bidPrice[0]).toBe(57800);
  });

  it("keeps books separate per symbol, and reset drops one", () => {
    const a = new DepthBookAssembler();
    a.apply("A", { bids: [level(0, 100)], asks: [] }, true);
    a.apply("B", { bids: [level(0, 200)], asks: [] }, true);
    expect(a.apply("A", { bids: [], asks: [] }, false).bidPrice[0]).toBe(100);
    a.reset("A");
    expect(a.apply("A", { bids: [], asks: [] }, false).bidPrice[0]).toBe(0);
    expect(a.apply("B", { bids: [], asks: [] }, false).bidPrice[0]).toBe(200);
  });

  it("produces a book the coherence gate accepts, where the vendor's ordering would not", () => {
    const a = new DepthBookAssembler();
    // The live signature: a sparse, out-of-order update. Assembled by num it is a real book.
    const book = a.apply("X", {
      bids: [level(2, 57798.4), level(0, 57800.0), level(1, 57799.2)],
      asks: [level(2, 57802.4), level(0, 57800.8), level(1, 57801.6)],
    }, true);

    const verdict = assessBook({
      bid: { price: book.bidPrice, qty: book.bidQty, orders: book.bidOrders },
      ask: { price: book.askPrice, qty: book.askQty, orders: book.askOrders },
      maximumSpreadFraction: FUTURES_LIMIT,
    });
    expect(verdict.verdict).toBe("COHERENT");
    expect(verdict.wasReordered).toBe(false);
    expect(verdict.spread).toBeCloseTo(0.8, 6);
  });
});
