import { describe, expect, it } from "vitest";
import { microprice, parseDepthFrame } from "./depth-frame.js";

const RECEIVED_AT = new Date("2026-08-21T08:15:11.123Z");

/**
 * A frame shaped like the vendor's `Depth` object, using values actually observed during the Phase 0
 * spike on NSE:BANKNIFTY26AUGFUT. Arrays are 50 long and zero-padded, as the SDK delivers them.
 */
function vendorFrame(overrides: Record<string, unknown> = {}) {
  const pad = (values: number[]) => {
    const out = new Array<number>(50).fill(0);
    values.forEach((value, index) => { out[index] = value; });
    return out;
  };
  return {
    bidprice: pad([57725, 57722.2, 57720, 57716.6, 57716.4]),
    bidqty: pad([30, 120, 30, 60, 90]),
    bidordn: pad([1, 1, 1, 1, 2]),
    askprice: pad([57749.6, 57750.2, 57750.4, 57750.8, 57751]),
    askqty: pad([30, 120, 90, 180, 210]),
    askordn: pad([1, 2, 3, 2, 4]),
    tbq: 37_350,
    tsq: 84_330,
    snapshot: false,
    timestamp: 1_787_300_311,
    sendtime: 1_787_300_311,
    seqNo: 32_648,
    ...overrides,
  };
}

describe("parseDepthFrame", () => {
  it("parses a realistic frame and upper-cases the symbol", () => {
    const frame = parseDepthFrame({
      providerSymbol: "nse:banknifty26augfut",
      raw: vendorFrame(),
      receivedAt: RECEIVED_AT,
      levelsToStore: 5,
    })!;

    expect(frame.providerSymbol).toBe("NSE:BANKNIFTY26AUGFUT");
    expect(frame.sequenceNo).toBe(32_648);
    expect(frame.exchangeFeedTime).toBe(1_787_300_311);
    expect(frame.vendorSendTime).toBe(1_787_300_311);
    expect(frame.receivedAt).toEqual(RECEIVED_AT);
    expect(frame.isSnapshot).toBe(false);
    expect(frame.totalBuyQty).toBe(37_350);
    expect(frame.totalSellQty).toBe(84_330);
    expect(frame.bidPrice).toEqual([57725, 57722.2, 57720, 57716.6, 57716.4]);
    expect(frame.bidQty).toEqual([30, 120, 30, 60, 90]);
    expect(frame.askOrders).toEqual([1, 2, 3, 2, 4]);
  });

  it("records how many levels were available when it truncates", () => {
    // The distinction nothing downstream can recover: 2 stored levels of a 5-level book is a
    // different quantity from a genuinely 2-level book.
    const frame = parseDepthFrame({
      providerSymbol: "X",
      raw: vendorFrame(),
      receivedAt: RECEIVED_AT,
      levelsToStore: 2,
    })!;

    expect(frame.levelsStored).toBe(2);
    expect(frame.levelsAvailable).toBe(5);
    expect(frame.bidPrice).toHaveLength(2);
    expect(frame.askPrice).toHaveLength(2);
  });

  it("keeps a genuinely thin book rather than padding it to the requested depth", () => {
    const thin = vendorFrame({
      bidprice: [100, 0, 0], bidqty: [5, 0, 0], bidordn: [1, 0, 0],
      askprice: [101, 0, 0], askqty: [7, 0, 0], askordn: [1, 0, 0],
    });
    const frame = parseDepthFrame({
      providerSymbol: "X", raw: thin, receivedAt: RECEIVED_AT, levelsToStore: 10,
    })!;

    expect(frame.levelsAvailable).toBe(1);
    expect(frame.levelsStored).toBe(1);
    expect(frame.bidPrice).toEqual([100]);
  });

  it("stores both sides to the same depth even when one is thinner", () => {
    // The alignment invariant migration 070 also enforces at rest: a ragged edge would let a
    // level-wise feature read across mismatched sides.
    const lopsided = vendorFrame({
      askprice: [101, 0, 0, 0, 0], askqty: [7, 0, 0, 0, 0], askordn: [1, 0, 0, 0, 0],
    });
    const frame = parseDepthFrame({
      providerSymbol: "X", raw: lopsided, receivedAt: RECEIVED_AT, levelsToStore: 10,
    })!;

    expect(frame.levelsStored).toBe(5);
    expect(frame.bidPrice).toHaveLength(5);
    expect(frame.askPrice).toHaveLength(5);
    expect(frame.askPrice).toEqual([101, 0, 0, 0, 0]);
  });

  it("copies the arrays instead of referencing the vendor's reused object", () => {
    // The SDK maintains ONE Depth instance per symbol and hands the same object to every callback.
    // A buffer of references would end a session holding N pointers to the final book.
    const raw = vendorFrame();
    const frame = parseDepthFrame({
      providerSymbol: "X", raw, receivedAt: RECEIVED_AT, levelsToStore: 5,
    })!;

    (raw.bidprice as number[])[0] = 99_999;
    (raw.bidqty as number[])[0] = 99_999;

    expect(frame.bidPrice[0]).toBe(57725);
    expect(frame.bidQty[0]).toBe(30);
  });

  it("refuses a frame with no priced level on either side", () => {
    const empty = vendorFrame({
      bidprice: new Array(50).fill(0), askprice: new Array(50).fill(0),
    });
    expect(parseDepthFrame({
      providerSymbol: "X", raw: empty, receivedAt: RECEIVED_AT, levelsToStore: 5,
    })).toBeNull();
  });

  it("refuses a blank symbol, a non-object payload, and an invalid clock", () => {
    expect(parseDepthFrame({
      providerSymbol: "  ", raw: vendorFrame(), receivedAt: RECEIVED_AT, levelsToStore: 5,
    })).toBeNull();
    expect(parseDepthFrame({
      providerSymbol: "X", raw: null, receivedAt: RECEIVED_AT, levelsToStore: 5,
    })).toBeNull();
    expect(parseDepthFrame({
      providerSymbol: "X", raw: vendorFrame(), receivedAt: new Date("nope"), levelsToStore: 5,
    })).toBeNull();
  });

  it("rejects a nonsensical level count loudly", () => {
    expect(() => parseDepthFrame({
      providerSymbol: "X", raw: vendorFrame(), receivedAt: RECEIVED_AT, levelsToStore: 0,
    })).toThrow(/positive integer/);
  });

  it("treats a missing sequence number or clock as null rather than zero", () => {
    const frame = parseDepthFrame({
      providerSymbol: "X",
      raw: vendorFrame({ seqNo: undefined, timestamp: null, sendtime: "nope" }),
      receivedAt: RECEIVED_AT,
      levelsToStore: 5,
    })!;

    expect(frame.sequenceNo).toBeNull();
    expect(frame.exchangeFeedTime).toBeNull();
    expect(frame.vendorSendTime).toBeNull();
  });

  it("marks a snapshot frame", () => {
    const frame = parseDepthFrame({
      providerSymbol: "X",
      raw: vendorFrame({ snapshot: true }),
      receivedAt: RECEIVED_AT,
      levelsToStore: 5,
    })!;
    expect(frame.isSnapshot).toBe(true);
  });

  describe("payloadDigest", () => {
    const base = { providerSymbol: "X", receivedAt: RECEIVED_AT, levelsToStore: 5 };

    it("is stable for an identical frame", () => {
      const first = parseDepthFrame({ ...base, raw: vendorFrame() })!;
      const second = parseDepthFrame({ ...base, raw: vendorFrame() })!;
      expect(first.payloadDigest).toBe(second.payloadDigest);
    });

    it("ignores receivedAt, so a replay at a later instant still matches", () => {
      // If the digest included our own clock, replay detection could never fire.
      const first = parseDepthFrame({ ...base, raw: vendorFrame() })!;
      const later = parseDepthFrame({
        ...base, raw: vendorFrame(), receivedAt: new Date(RECEIVED_AT.getTime() + 60_000),
      })!;
      expect(first.payloadDigest).toBe(later.payloadDigest);
    });

    it("changes when the book changes", () => {
      const first = parseDepthFrame({ ...base, raw: vendorFrame() })!;
      const moved = parseDepthFrame({
        ...base, raw: vendorFrame({ bidqty: new Array(50).fill(0).map((_, i) => (i === 0 ? 31 : 0)) }),
      })!;
      expect(first.payloadDigest).not.toBe(moved.payloadDigest);
    });
  });
});

describe("microprice", () => {
  it("weights toward the side with less size", () => {
    // Heavy bid size means the next trade is likelier to lift the ask, so the microprice sits above
    // the plain mid of 100.5.
    const value = microprice({
      bidPrice: [100], bidQty: [900], askPrice: [101], askQty: [100],
    })!;
    expect(value).toBeGreaterThan(100.5);
    expect(value).toBeCloseTo(((100 * 100) + (101 * 900)) / 1_000, 10);
  });

  it("equals the plain mid when both sides carry equal size", () => {
    expect(microprice({ bidPrice: [100], bidQty: [50], askPrice: [101], askQty: [50] }))
      .toBeCloseTo(100.5, 10);
  });

  it("falls back to the plain mid when neither side reports size", () => {
    expect(microprice({ bidPrice: [100], bidQty: [0], askPrice: [101], askQty: [0] }))
      .toBeCloseTo(100.5, 10);
  });

  it("returns null for a one-sided book rather than inventing a mid", () => {
    expect(microprice({ bidPrice: [100], bidQty: [10], askPrice: [0], askQty: [0] })).toBeNull();
    expect(microprice({ bidPrice: [0], bidQty: [0], askPrice: [101], askQty: [10] })).toBeNull();
  });

  it("returns null for an empty book", () => {
    expect(microprice({ bidPrice: [], bidQty: [], askPrice: [], askQty: [] })).toBeNull();
  });
});
