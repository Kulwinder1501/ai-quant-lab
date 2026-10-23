import { describe, expect, it } from "vitest";
import {
  BALANCED_BAND,
  bookAgeSeconds,
  buildLadderRows,
  coverageSentence,
  DEFAULT_VISIBLE_LEVELS,
  DEPTH_UNDERLYINGS,
  DEPTH_STALE_AFTER_SECONDS,
  describeImbalance,
  effectiveStatus,
  presentStatus,
  topLevels,
  type DepthLevelView,
} from "./depth-ladder-view";

const lvl = (level: number, price: number, qty: number, cumulativeQty: number, orders: number | null = 1): DepthLevelView => ({
  level, price, qty, orders, cumulativeQty,
});

describe("describeImbalance", () => {
  it("pairs the sign with a word so direction does not rest on colour", () => {
    expect(describeImbalance(0.33)).toEqual({ text: "+0.33", word: "bid-heavy" });
    expect(describeImbalance(-0.36)).toEqual({ text: "-0.36", word: "ask-heavy" });
  });

  it("calls a small imbalance balanced, at and inside the band", () => {
    expect(describeImbalance(BALANCED_BAND - 0.001).word).toBe("balanced");
    expect(describeImbalance(-(BALANCED_BAND - 0.001)).word).toBe("balanced");
    expect(describeImbalance(BALANCED_BAND).word).toBe("bid-heavy");
    expect(describeImbalance(-BALANCED_BAND).word).toBe("ask-heavy");
  });

  it("writes a value that rounds to zero as 0.00, never +0.00 or -0.00", () => {
    expect(describeImbalance(0).text).toBe("0.00");
    expect(describeImbalance(-0.001).text).toBe("0.00");
    expect(describeImbalance(0.004).text).toBe("0.00");
  });

  it("shows not available as a dash, distinct from balanced", () => {
    expect(describeImbalance(null)).toEqual({ text: "—", word: "not available" });
    expect(describeImbalance(Number.NaN)).toEqual({ text: "—", word: "not available" });
  });
});

describe("buildLadderRows", () => {
  const bids = [lvl(1, 100, 60, 60), lvl(2, 99.8, 30, 90)];
  const asks = [lvl(1, 100.2, 30, 30), lvl(2, 100.4, 120, 150)];

  it("lists asks from the deepest down to the touch, then bids from the touch down", () => {
    const rows = buildLadderRows({ bids, asks }, 30);
    expect(rows.map((r) => `${r.side}${r.level}`)).toEqual(["ask2", "ask1", "bid1", "bid2"]);
    expect(rows.map((r) => r.price)).toEqual([100.4, 100.2, 100, 99.8]);
  });

  it("scales every bar against the single largest level on either side, so the two sides compare", () => {
    const rows = buildLadderRows({ bids, asks }, 30);
    const byKey = Object.fromEntries(rows.map((r) => [`${r.side}${r.level}`, r.barFraction]));
    expect(byKey.ask2).toBe(1); // 120 is the largest
    expect(byKey.bid1).toBeCloseTo(0.5, 10);
    expect(byKey.ask1).toBeCloseTo(0.25, 10);
  });

  it("converts units to lots, and leaves lots null when the lot size is unknown", () => {
    expect(buildLadderRows({ bids, asks }, 30).find((r) => r.side === "bid" && r.level === 1)!.lots).toBe(2);
    expect(buildLadderRows({ bids, asks }, null).every((r) => r.lots === null)).toBe(true);
    expect(buildLadderRows({ bids, asks }, 0).every((r) => r.lots === null)).toBe(true);
  });

  it("copes with an empty book without dividing by zero", () => {
    expect(buildLadderRows({ bids: [], asks: [] }, 30)).toEqual([]);
    const rows = buildLadderRows({ bids: [lvl(1, 100, 0, 0)], asks: [] }, 30);
    expect(rows[0]!.barFraction).toBe(0);
  });

  it("keeps cumulative quantity and order counts as given", () => {
    const row = buildLadderRows({ bids, asks }, 30).find((r) => r.side === "ask" && r.level === 2)!;
    expect(row.cumulativeQty).toBe(150);
    expect(row.orders).toBe(1);
  });
});

describe("bookAgeSeconds", () => {
  it("adds the time since the response arrived to the server's age, so a silent API makes the book older", () => {
    expect(bookAgeSeconds(1.5, 10_000, 10_000)).toBe(1.5);
    expect(bookAgeSeconds(1.5, 10_000, 14_000)).toBe(5.5);
    expect(bookAgeSeconds(1.5, 10_000, 70_000)).toBe(61.5);
  });

  it("never lets a client clock behind the fetch make the book look younger", () => {
    expect(bookAgeSeconds(2, 10_000, 9_000)).toBe(2);
  });
});

describe("coverageSentence", () => {
  it("states the reach and the share of the whole book the stored levels hold", () => {
    const sentence = coverageSentence({
      levelsStored: 10,
      levelsAvailable: 50,
      reachPoints: { bid: 5.4, ask: 8.4 },
      storedShareOfWholeBook: { bid: 0.024, ask: 0.016 },
      wholeBookTotals: { bid: 44_850, ask: 66_000 },
    });
    expect(sentence).toBe(
      "Top 10 of 50 levels only: they reach 5.4 pts on the bid and 8.4 pts on the ask, and hold 2.4% of the whole book's resting bid quantity and 1.6% of its ask.",
    );
  });

  it("says all the levels are stored when the frame holds every level the feed carried, not that it is the top", () => {
    const sentence = coverageSentence({
      levelsStored: 50,
      levelsAvailable: 50,
      reachPoints: { bid: 41.2, ask: 63.8 },
      storedShareOfWholeBook: { bid: 0.31, ask: 0.27 },
      wholeBookTotals: { bid: 44_850, ask: 66_000 },
    });
    expect(sentence).toBe(
      "All 50 levels the feed carried are stored: they reach 41.2 pts on the bid and 63.8 pts on the ask, and hold 31.0% of the whole book's resting bid quantity and 27.0% of its ask.",
    );
    expect(sentence).not.toContain("only");
  });

  it("says n/a where a figure is unknown rather than printing a zero", () => {
    const sentence = coverageSentence({
      levelsStored: 10, levelsAvailable: 50,
      reachPoints: { bid: null, ask: null },
      storedShareOfWholeBook: { bid: null, ask: null },
      wholeBookTotals: { bid: null, ask: null },
    });
    expect(sentence).toContain("n/a");
    expect(sentence).not.toContain("0.0%");
  });
});

describe("topLevels", () => {
  const side = (count: number) => Array.from({ length: count }, (_, i) => lvl(i + 1, 100 + i, 10 * (i + 1), 0));

  it("keeps the first levels of each side and leaves the original untouched", () => {
    const ladder = { bids: side(50), asks: side(30) };
    const shown = topLevels(ladder, DEFAULT_VISIBLE_LEVELS);
    expect(shown.bids).toHaveLength(10);
    expect(shown.asks).toHaveLength(10);
    expect(shown.bids[9]!.level).toBe(10);
    expect(ladder.bids).toHaveLength(50);
  });

  it("scales the bars against what is shown, so a huge deep level does not flatten the visible ones", () => {
    const deep = side(12);
    deep[11] = lvl(12, 111, 9_999_999, 0);
    const all = buildLadderRows({ bids: deep, asks: side(12) }, 30);
    const shown = buildLadderRows(topLevels({ bids: deep, asks: side(12) }, 10), 30);
    expect(Math.max(...all.filter((r) => r.level <= 10).map((r) => r.barFraction))).toBeLessThan(0.001);
    expect(Math.max(...shown.map((r) => r.barFraction))).toBe(1);
  });

  it("returns what exists when a side is shorter than the count", () => {
    expect(topLevels({ bids: side(3), asks: side(0) }, 10)).toEqual({ bids: side(3), asks: [] });
  });
});

describe("presentStatus and underlyings", () => {
  it("gives every status a label, tone and an explanation", () => {
    for (const status of ["LIVE", "STALE", "OUT_OF_SESSION", "HISTORICAL"] as const) {
      const presented = presentStatus(status);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(presented.detail.length).toBeGreaterThan(10);
    }
    expect(presentStatus("LIVE").tone).toBe("ok");
    expect(presentStatus("STALE").tone).toBe("warn");
    expect(presentStatus("OUT_OF_SESSION").detail).toContain("not a live one");
  });

  it("limits depth to the two index futures the endpoint can resolve", () => {
    expect(DEPTH_UNDERLYINGS).toEqual(["NIFTY50", "BANKNIFTY"]);
  });
});

describe("effectiveStatus", () => {
  it("lets a LIVE verdict lapse to STALE once the book on screen is older than the threshold", () => {
    // Found by stopping the API under the page: the age reached 11 seconds beneath a LIVE badge.
    expect(effectiveStatus("LIVE", 1)).toBe("LIVE");
    expect(effectiveStatus("LIVE", DEPTH_STALE_AFTER_SECONDS)).toBe("LIVE");
    expect(effectiveStatus("LIVE", DEPTH_STALE_AFTER_SECONDS + 0.1)).toBe("STALE");
    expect(effectiveStatus("LIVE", 11)).toBe("STALE");
  });

  it("leaves every other status alone, since each already says the book is not live", () => {
    for (const status of ["STALE", "OUT_OF_SESSION", "HISTORICAL"] as const) {
      expect(effectiveStatus(status, 0)).toBe(status);
      expect(effectiveStatus(status, 99_999)).toBe(status);
    }
  });

  it("agrees with the API's own threshold", () => {
    expect(DEPTH_STALE_AFTER_SECONDS).toBe(10);
  });
});
