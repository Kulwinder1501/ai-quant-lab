import { describe, expect, it } from "vitest";
import {
  buildDepthLadder,
  captureRegimeOf,
  DEPTH_QUANTITY_UNIT,
  DEPTH_REGIME_B_START,
  DEPTH_STALE_AFTER_SECONDS,
  isDepthSession,
  type StoredDepthFrame,
} from "./depth-ladder.js";

/** 2026-10-12 is a Monday; IST = UTC + 5:30, so 10:00 IST = 04:30Z. */
const MON_1000_IST = new Date("2026-10-12T04:30:00.000Z");
const SAT_1000_IST = new Date("2026-10-17T04:30:00.000Z");

/** Synthetic frames (hand-built for the arithmetic below, not recorded from the feed). */
function frame(overrides: Partial<StoredDepthFrame> = {}): StoredDepthFrame {
  return {
    providerSymbol: "NSE:BANKNIFTY26OCTFUT",
    sequenceNo: 100,
    exchangeFeedTime: 1_792_000_000,
    receivedAt: MON_1000_IST,
    isSnapshot: false,
    levelsStored: 3,
    levelsAvailable: 50,
    bidPrice: [54_200, 54_199.8, 54_199.6],
    bidQty: [60, 30, 30],
    bidOrders: [2, 1, 1],
    askPrice: [54_220, 54_220.2, 54_220.4],
    askQty: [30, 30, 60],
    askOrders: [1, 1, 3],
    totalBuyQty: 28_080,
    totalSellQty: 60_270,
    gapBefore: 0,
    isDuplicate: false,
    captureSessionId: "session-1",
    ...overrides,
  };
}

const at = (seconds: number) => new Date(MON_1000_IST.getTime() + seconds * 1000);

describe("buildDepthLadder: the ladder", () => {
  it("numbers levels from the touch and accumulates quantity outward", () => {
    const ladder = buildDepthLadder(frame(), { now: at(1) });
    expect(ladder.bids.map((l) => [l.level, l.price, l.qty, l.cumulativeQty])).toEqual([
      [1, 54_200, 60, 60], [2, 54_199.8, 30, 90], [3, 54_199.6, 30, 120],
    ]);
    expect(ladder.asks.map((l) => [l.level, l.price, l.qty, l.cumulativeQty])).toEqual([
      [1, 54_220, 30, 30], [2, 54_220.2, 30, 60], [3, 54_220.4, 60, 120],
    ]);
    expect(ladder.bids[0]!.orders).toBe(2);
    expect(ladder.quantityUnit).toBe(DEPTH_QUANTITY_UNIT);
  });

  it("derives the touch, mid and spread in points and basis points", () => {
    const ladder = buildDepthLadder(frame(), { now: at(1) });
    expect(ladder.bestBid).toBe(54_200);
    expect(ladder.bestAsk).toBe(54_220);
    expect(ladder.mid).toBe(54_210);
    expect(ladder.spread!.points).toBeCloseTo(20, 10);
    expect(ladder.spread!.basisPoints).toBeCloseTo((20 / 54_210) * 10_000, 8);
  });

  it("skips zero padding, so a thin book has fewer levels and no phantom ones", () => {
    const ladder = buildDepthLadder(
      frame({ bidPrice: [54_200, 0, 0], bidQty: [60, 0, 0], bidOrders: [2, 0, 0] }),
      { now: at(1) },
    );
    expect(ladder.bids).toHaveLength(1);
    expect(ladder.asks).toHaveLength(3);
  });
});

describe("buildDepthLadder: imbalance, defined exactly", () => {
  it("top-of-book is (bid - ask) / (bid + ask) over the first k levels, and null when a side is short", () => {
    const { imbalance } = buildDepthLadder(frame(), { now: at(1) });
    // k=1: (60 - 30) / 90
    expect(imbalance.topOfBook.l1).toBeCloseTo(30 / 90, 10);
    // k=3: bid 120, ask 120
    expect(imbalance.topOfBook.l3).toBeCloseTo(0, 10);
    // Only three levels are stored, so k=5 and k=10 cannot be computed and must not be approximated.
    expect(imbalance.topOfBook.l5).toBeNull();
    expect(imbalance.topOfBook.l10).toBeNull();
  });

  it("rank-weighted divides each level's quantity by its rank", () => {
    const { imbalance } = buildDepthLadder(frame(), { now: at(1) });
    // bid: 60 + 30/2 + 30/3 = 85; ask: 30 + 30/2 + 60/3 = 65
    expect(imbalance.rankWeighted).toBeCloseTo((85 - 65) / (85 + 65), 10);
  });

  it("whole-book comes from the feed's own totals, which cover levels that are not stored", () => {
    const { imbalance } = buildDepthLadder(frame(), { now: at(1) });
    expect(imbalance.wholeBook).toBeCloseTo((28_080 - 60_270) / (28_080 + 60_270), 10);
  });

  it("whole-book is null without totals or with both zero, never a made-up zero", () => {
    expect(buildDepthLadder(frame({ totalBuyQty: null, totalSellQty: null }), { now: at(1) }).imbalance.wholeBook).toBeNull();
    expect(buildDepthLadder(frame({ totalBuyQty: 0, totalSellQty: 0 }), { now: at(1) }).imbalance.wholeBook).toBeNull();
    expect(buildDepthLadder(frame({ totalBuyQty: 100, totalSellQty: null }), { now: at(1) }).imbalance.wholeBook).toBeNull();
  });
});

describe("buildDepthLadder: coverage, so a top-of-book figure is not read as the book's", () => {
  it("reports how far the stored levels reach and what share of the whole book they hold", () => {
    const { coverage } = buildDepthLadder(frame(), { now: at(1) });
    expect(coverage.levelsStored).toBe(3);
    expect(coverage.levelsAvailable).toBe(50);
    expect(coverage.reachPoints.bid).toBeCloseTo(0.4, 10);
    expect(coverage.reachPoints.ask).toBeCloseTo(0.4, 10);
    // 120 of 28,080 on the bid side; 120 of 60,270 on the ask side.
    expect(coverage.storedShareOfWholeBook.bid).toBeCloseTo(120 / 28_080, 10);
    expect(coverage.storedShareOfWholeBook.ask).toBeCloseTo(120 / 60_270, 10);
    expect(coverage.wholeBookTotals).toEqual({ bid: 28_080, ask: 60_270 });
  });

  it("leaves the share null when the feed gave no total to divide by", () => {
    const { coverage } = buildDepthLadder(frame({ totalBuyQty: null, totalSellQty: 0 }), { now: at(1) });
    expect(coverage.storedShareOfWholeBook).toEqual({ bid: null, ask: null });
  });
});

describe("buildDepthLadder: a book that cannot exist", () => {
  it("withholds every level-indexed figure from a crossed book, and says why", () => {
    const ladder = buildDepthLadder(frame({ askPrice: [54_199, 54_220.2, 54_220.4] }), { now: at(1) });
    expect(ladder.coherent).toBe(false);
    expect(ladder.issues.join(" ")).toContain("crossed");
    expect(ladder.bestBid).toBeNull();
    expect(ladder.bestAsk).toBeNull();
    expect(ladder.mid).toBeNull();
    expect(ladder.spread).toBeNull();
    expect(ladder.imbalance.topOfBook).toEqual({ l1: null, l3: null, l5: null, l10: null });
    expect(ladder.imbalance.rankWeighted).toBeNull();
    // The whole-book totals are order-independent scalars, valid whatever the levels did.
    expect(ladder.imbalance.wholeBook).not.toBeNull();
  });

  it("flags bids that do not fall away from the touch, and asks that do not rise", () => {
    const badBids = buildDepthLadder(frame({ bidPrice: [54_200, 54_201, 54_199.6] }), { now: at(1) });
    expect(badBids.coherent).toBe(false);
    expect(badBids.issues.join(" ")).toContain("Bid prices");
    const badAsks = buildDepthLadder(frame({ askPrice: [54_220, 54_219, 54_220.4] }), { now: at(1) });
    expect(badAsks.coherent).toBe(false);
    expect(badAsks.issues.join(" ")).toContain("Ask prices");
  });

  it("treats a duplicated price as a failure, since strictly monotone is the rule", () => {
    expect(buildDepthLadder(frame({ bidPrice: [54_200, 54_200, 54_199.6] }), { now: at(1) }).coherent).toBe(false);
  });
});

describe("capture regimes", () => {
  it("puts the boundary at the assembler restart plus its 20 second settle", () => {
    const start = DEPTH_REGIME_B_START.getTime();
    expect(captureRegimeOf(new Date(start + 19_000))).toBe("ARRIVAL_INDEX");
    expect(captureRegimeOf(new Date(start + 20_000))).toBe("KEYED_BY_LEVEL_NUMBER");
  });

  it("refuses level metrics for the old regime but keeps the whole-book totals, which were always valid", () => {
    const ladder = buildDepthLadder(frame({ receivedAt: new Date("2026-09-01T05:00:00.000Z") }), { now: at(1), historical: true });
    expect(ladder.captureRegime).toBe("ARRIVAL_INDEX");
    expect(ladder.issues.join(" ")).toContain("arrival index");
    expect(ladder.coherent).toBe(true); // the invariants may hold by luck; the regime still disqualifies it
    expect(ladder.bestBid).toBeNull();
    expect(ladder.spread).toBeNull();
    expect(ladder.imbalance.topOfBook.l1).toBeNull();
    expect(ladder.imbalance.wholeBook).not.toBeNull();
  });
});

describe("status", () => {
  it("is LIVE in session when the frame is fresh", () => {
    expect(buildDepthLadder(frame(), { now: at(1) }).status).toBe("LIVE");
  });

  it("is STALE in session past the threshold, rather than silently showing an old book as current", () => {
    expect(buildDepthLadder(frame(), { now: at(DEPTH_STALE_AFTER_SECONDS) }).status).toBe("LIVE");
    expect(buildDepthLadder(frame(), { now: at(DEPTH_STALE_AFTER_SECONDS + 1) }).status).toBe("STALE");
  });

  it("is OUT_OF_SESSION when now is outside trading hours, however old the frame", () => {
    const saturdayFrame = frame({ receivedAt: new Date(SAT_1000_IST.getTime() - 3_600_000) });
    expect(buildDepthLadder(saturdayFrame, { now: SAT_1000_IST }).status).toBe("OUT_OF_SESSION");
  });

  it("is HISTORICAL when the caller asked for a past instant", () => {
    expect(buildDepthLadder(frame(), { now: at(1), historical: true }).status).toBe("HISTORICAL");
  });

  it("never reports a negative age for a frame stamped ahead of the clock", () => {
    expect(buildDepthLadder(frame(), { now: at(-5) }).ageSeconds).toBe(0);
  });
});

describe("isDepthSession", () => {
  const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);
  it("covers Monday to Friday 09:00 to 15:30 IST, end exclusive", () => {
    expect(isDepthSession(ist("2026-10-12", "08:59"))).toBe(false);
    expect(isDepthSession(ist("2026-10-12", "09:00"))).toBe(true);
    expect(isDepthSession(ist("2026-10-12", "15:29"))).toBe(true);
    expect(isDepthSession(ist("2026-10-12", "15:30"))).toBe(false);
    expect(isDepthSession(ist("2026-10-17", "11:00"))).toBe(false); // Saturday
    expect(isDepthSession(ist("2026-10-18", "11:00"))).toBe(false); // Sunday
  });
});

describe("provenance", () => {
  it("carries the sequence, capture session and gap marker, and does not expose the unreliable regression flag", () => {
    const { provenance } = buildDepthLadder(frame({ gapBefore: 3 }), { now: at(1) });
    expect(provenance).toMatchObject({ sequenceNo: 100, gapBefore: 3, captureSessionId: "session-1", isSnapshot: false, isDuplicate: false });
    // is_regression flagged 42% of frames against a 0.3% true rate (measured), so it is not a signal.
    expect(Object.keys(provenance)).not.toContain("isRegression");
  });
});
