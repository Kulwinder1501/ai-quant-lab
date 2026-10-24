import { describe, expect, it } from "vitest";
import {
  ageNow,
  ageSentence,
  ageStateWord,
  ageText,
  contractFlag,
  indexContracts,
  type AgeView,
  type StalenessPayload,
} from "./quote-staleness";

/** 2026-10-26 is a Monday; IST is UTC+5:30. Synthetic, hand-built. */
const ist = (hhmm: string): string => new Date(new Date(`2026-10-26T${hhmm}:00.000Z`).getTime() - 330 * 60_000).toISOString();
const ms = (hhmm: string): number => new Date(ist(hhmm)).getTime();

const age = (overrides: Partial<AgeView> = {}): AgeView => ({
  state: "fresh", newestAt: ist("12:11"), ageSeconds: 14 * 60, expectedGapSeconds: 18 * 60, expectedGapFrom: "observed", agingFactor: 1, overdueFactor: 1.5, ...overrides,
});

const payload = (overrides: Partial<StalenessPayload> = {}): StalenessPayload => ({
  underlyingSymbol: "BANKNIFTY", expiryDate: "2026-10-27", asOf: ist("12:25"), marketOpen: true, holiday: null, window: 8,
  snapshotTimes: [ist("12:11")], age: age(), contracts: [], definitions: {}, ...overrides,
});

describe("ageText", () => {
  it("is whole minutes, then hours and minutes, and says so under a minute", () => {
    expect(ageText(30)).toBe("under a minute");
    expect(ageText(14 * 60 + 59)).toBe("14 min");
    expect(ageText(65 * 60)).toBe("1 h 05 min");
  });
});

describe("ageNow", () => {
  it("re-judges the age against the expected gap as the page's clock moves on, with the same boundaries as the server", () => {
    expect(ageNow(age(), ms("12:29"))).toEqual({ ageSeconds: 18 * 60, state: "fresh" });      // exactly the gap
    expect(ageNow(age(), ms("12:30"))).toEqual({ ageSeconds: 19 * 60, state: "aging" });
    expect(ageNow(age(), ms("12:38"))).toEqual({ ageSeconds: 27 * 60, state: "aging" });      // exactly 1.5 times
    expect(ageNow(age(), ms("12:39"))).toEqual({ ageSeconds: 28 * 60, state: "overdue" });
  });

  it("keeps the server's word when it did not judge: market closed, awaiting the first snapshot, nothing stored", () => {
    expect(ageNow(age({ state: "market-closed" }), ms("16:00")).state).toBe("market-closed");
    expect(ageNow(age({ state: "awaiting-first" }), ms("12:30")).state).toBe("awaiting-first");
    expect(ageNow(age({ state: "none", newestAt: null, ageSeconds: null }), ms("12:30"))).toEqual({ ageSeconds: null, state: "none" });
  });

  it("never reports a negative age when the page's clock is behind the server's", () => {
    expect(ageNow(age(), ms("12:00")).ageSeconds).toBe(0);
  });
});

describe("ageSentence", () => {
  it("says when the chain was observed, how old it is, and what it is judged against", () => {
    expect(ageSentence(payload(), ms("12:25"))).toBe("The stored chain was observed at 12:11 IST, 14 min ago: within the usual gap (the longest gap lately was 18 min between runs).");
  });

  it("says aging and overdue in their own words, and that overdue quotes should be treated as old", () => {
    expect(ageSentence(payload(), ms("12:35"))).toContain("past the usual gap but not yet missed a run");
    const overdue = ageSentence(payload(), ms("13:10"));
    expect(overdue).toContain("59 min ago");
    expect(overdue).toContain("runs have probably been missed");
    expect(overdue).toContain("Treat these quotes as old.");
  });

  it("says plainly when the cadence is assumed rather than seen", () => {
    expect(ageSentence(payload({ age: age({ expectedGapFrom: "assumed" }) }), ms("12:25"))).toContain("too few recent snapshots to see the cadence, so the schedule's widest gap (18 min between runs) is assumed");
  });

  it("does not judge a closed market, and names a holiday", () => {
    const closed = ageSentence(payload({ marketOpen: false, age: age({ state: "market-closed" }) }), ms("16:00"));
    expect(closed).toContain("The market is closed, so these are the last quotes of the most recent session and no age is judged.");
    expect(ageSentence(payload({ marketOpen: false, holiday: "Diwali", age: age({ state: "market-closed" }) }), ms("16:00"))).toContain("The exchange is closed today (Diwali)");
  });

  it("says when nothing is stored, and when today's first snapshot is not in yet", () => {
    expect(ageSentence(payload({ age: age({ state: "none", newestAt: null, ageSeconds: null }) }), ms("12:25"))).toBe("No chain snapshot is stored for this underlying yet.");
    expect(ageSentence(payload({ age: age({ state: "awaiting-first" }) }), ms("12:25"))).toContain("The first snapshot of today's session is not in yet.");
  });

  it("has a word for every state", () => {
    expect(["none", "market-closed", "awaiting-first", "fresh", "aging", "overdue"].map((state) => ageStateWord(state as never))).toEqual([
      "no snapshot stored", "market closed", "awaiting today's first snapshot", "fresh", "aging", "overdue",
    ]);
  });
});

describe("contractFlag", () => {
  const row = (unchangedSnapshots: number) => ({ strike: 54_300, side: "CE" as const, unchangedSnapshots, unchangedSinceAt: ist("11:23") });

  it("flags a quote that has repeated across three or more newest snapshots, with since when", () => {
    const flag = contractFlag(row(4), true);
    expect(flag).toMatchObject({ flagged: true, cell: "same ×4" });
    expect(flag.sentence).toContain("exactly the same in the last 4 snapshots, since 11:23 IST");
    expect(flag.sentence).toContain("not proof the price is stale");
  });

  it("does not flag one or two in a row, which is ordinary", () => {
    expect(contractFlag(row(2), true)).toEqual({ flagged: false, cell: "moved", sentence: null });
    expect(contractFlag(row(1), true).flagged).toBe(false);
  });

  it("does not judge anything while the market is shut (every quote is unchanged then), nor a contract with no record", () => {
    expect(contractFlag(row(8), false)).toEqual({ flagged: false, cell: "–", sentence: null });
    expect(contractFlag(undefined, true)).toEqual({ flagged: false, cell: "–", sentence: null });
  });
});

describe("indexContracts", () => {
  it("looks a contract up by strike and side", () => {
    const map = indexContracts([{ strike: 54_300, side: "CE", unchangedSnapshots: 2, unchangedSinceAt: ist("11:53") }]);
    expect(map.get("54300|CE")?.unchangedSnapshots).toBe(2);
    expect(map.get("54300|PE")).toBeUndefined();
  });
});
