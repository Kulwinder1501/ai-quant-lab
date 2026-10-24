import { describe, expect, it } from "vitest";
import {
  ASSUMED_EXPECTED_GAP_SECONDS,
  ageStateOf,
  assessAge,
  contractStaleness,
  isMarketOpen,
  recentSessionGaps,
  type SnapshotQuotes,
} from "./quote-staleness.js";

/** 2026-10-26 is a Monday, 10-24 a Saturday, 10-23 a Friday. IST is UTC+5:30. */
const ist = (date: string, hhmm: string): Date => new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - 330 * 60_000);
const MON = "2026-10-26";

describe("isMarketOpen", () => {
  it("is open on an IST weekday from 09:15 up to, not including, 15:30", () => {
    expect(isMarketOpen(ist(MON, "09:15"), false)).toBe(true);
    expect(isMarketOpen(ist(MON, "15:29"), false)).toBe(true);
    expect(isMarketOpen(ist(MON, "09:14"), false)).toBe(false);
    expect(isMarketOpen(ist(MON, "15:30"), false)).toBe(false);
  });

  it("is shut on a weekend and on a listed holiday", () => {
    expect(isMarketOpen(ist("2026-10-24", "10:30"), false)).toBe(false);
    expect(isMarketOpen(ist(MON, "10:30"), true)).toBe(false);
  });
});

describe("recentSessionGaps", () => {
  it("takes the gaps between consecutive in-session snapshots of one day, whatever order they arrive in", () => {
    const times = [ist(MON, "11:23"), ist(MON, "12:11"), ist(MON, "11:41"), ist(MON, "11:53")];
    expect(recentSessionGaps(times)).toEqual([18 * 60, 12 * 60, 18 * 60]);       // 12:11-11:53, 11:53-11:41, 11:41-11:23
  });

  it("leaves out a gap that spans a close, a day, the pre-open snapshot, or a stretch longer than 90 minutes", () => {
    const times = [ist(MON, "09:23"), ist(MON, "09:11"), ist("2026-10-23", "15:41"), ist(MON, "11:23")];
    // 09:23 and 09:11: 09:11 is before the open. 09:11 and 10-23 15:41: different days. 11:23 and 09:23: 120 minutes.
    expect(recentSessionGaps(times)).toEqual([]);
  });
});

describe("ageStateOf", () => {
  it("is fresh up to the expected gap, aging up to 1.5 times it, overdue beyond", () => {
    expect(ageStateOf(1080, 1080)).toBe("fresh");
    expect(ageStateOf(1081, 1080)).toBe("aging");
    expect(ageStateOf(1620, 1080)).toBe("aging");
    expect(ageStateOf(1621, 1080)).toBe("overdue");
  });
});

describe("assessAge", () => {
  // The collector's real rhythm: 11:23 11:41 11:53 12:11 12:23, gaps of 18, 12, 18, 12 minutes; the longest is 18.
  const times = ["11:23", "11:41", "11:53", "12:11", "12:23"].map((hhmm) => ist(MON, hhmm));

  it("judges the age against the longest recent in-session gap", () => {
    const at = (hhmm: string) => assessAge(times, ist(MON, hhmm), true);
    expect(at("12:41")).toMatchObject({ state: "fresh", ageSeconds: 18 * 60, expectedGapSeconds: 18 * 60, expectedGapFrom: "observed" });
    expect(at("12:45")).toMatchObject({ state: "aging", ageSeconds: 22 * 60 });      // 22 <= 27
    expect(at("12:55")).toMatchObject({ state: "overdue", ageSeconds: 32 * 60 });    // 32 > 27
  });

  it("assumes the schedule's widest gap when fewer than two snapshots can be compared, and says so", () => {
    const one = assessAge([ist(MON, "12:23")], ist(MON, "12:35"), true);
    expect(one).toMatchObject({ state: "fresh", expectedGapSeconds: ASSUMED_EXPECTED_GAP_SECONDS, expectedGapFrom: "assumed" });
  });

  it("reports the age but does not judge it when the market is shut", () => {
    const closed = assessAge(times, ist(MON, "16:30"), false);
    expect(closed).toMatchObject({ state: "market-closed", ageSeconds: 247 * 60 });  // 12:23 to 16:30
  });

  it("has nothing to age when no snapshot is stored", () => {
    expect(assessAge([], ist(MON, "12:00"), true)).toMatchObject({ state: "none", newestAt: null, ageSeconds: null });
  });

  it("waits for the first snapshot of the day shortly after the open rather than calling yesterday's chain overdue", () => {
    const friday = [ist("2026-10-23", "15:41")];
    expect(assessAge(friday, ist(MON, "09:20"), true).state).toBe("awaiting-first");
    expect(assessAge(friday, ist(MON, "09:40"), true).state).toBe("overdue");
  });
});

describe("contractStaleness", () => {
  const q = (strike: number, side: "CE" | "PE", bid: number | null, ask: number | null) => ({ strike, side, bid, ask });
  const snapshots: SnapshotQuotes[] = [
    { observedAt: ist(MON, "12:11"), quotes: [q(54_300, "CE", 330, 336), q(54_300, "PE", 310, 316), q(54_900, "CE", 80, 90), q(55_000, "CE", null, 70), q(54_000, "CE", 490, 505)] },
    { observedAt: ist(MON, "11:53"), quotes: [q(54_300, "CE", 330, 336), q(54_300, "PE", 310, 316), q(55_000, "CE", 60, 70), q(54_000, "CE", 490, 505)] },
    { observedAt: ist(MON, "11:41"), quotes: [q(54_300, "CE", 330, 336), q(54_300, "PE", 305, 316), q(54_900, "CE", 80, 90), q(54_000, "CE", 490, 505)] },
    { observedAt: ist("2026-10-23", "15:41"), quotes: [q(54_000, "CE", 490, 505), q(54_300, "CE", 330, 336)] },
  ];
  const byKey = (rows: ReturnType<typeof contractStaleness>) => Object.fromEntries(rows.map((row) => [`${row.strike}${row.side}`, row]));

  it("counts the newest snapshots in a row with exactly the same bid and ask, and when the run began", () => {
    const rows = byKey(contractStaleness(snapshots));
    // 54,300 CE: the same in 12:11, 11:53 and 11:41, so 3 in a row since 11:41 (the 10-23 snapshot is another day and does not count).
    expect(rows["54300CE"]).toMatchObject({ unchangedSnapshots: 3, unchangedSinceAt: ist(MON, "11:41").toISOString() });
    // 54,300 PE: 310/316 at 12:11 and 11:53, 305/316 at 11:41, so the run is 2 and began at 11:53.
    expect(rows["54300PE"]).toMatchObject({ unchangedSnapshots: 2, unchangedSinceAt: ist(MON, "11:53").toISOString() });
    // 54,000 CE is unchanged back to the previous day's close, yet the run stops at the day boundary: 3 today.
    expect(rows["54000CE"]).toMatchObject({ unchangedSnapshots: 3 });
  });

  it("ends a run at a snapshot that lacks the contract (absent is not unchanged)", () => {
    // 54,900 CE is in 12:11 and 11:41 but not 11:53, so it changed from the newest snapshot's point of view: run of 1.
    expect(byKey(contractStaleness(snapshots))["54900CE"]).toMatchObject({ unchangedSnapshots: 1, unchangedSinceAt: ist(MON, "12:11").toISOString() });
  });

  it("leaves out a contract with a one-sided quote in the newest snapshot", () => {
    expect(byKey(contractStaleness(snapshots))["55000CE"]).toBeUndefined();
  });

  it("is empty with no snapshot, and 1 everywhere with a single snapshot", () => {
    expect(contractStaleness([])).toEqual([]);
    expect(contractStaleness([snapshots[0]!]).every((row) => row.unchangedSnapshots === 1)).toBe(true);
  });

  it("lists contracts by strike, calls before puts", () => {
    expect(contractStaleness(snapshots).map((row) => `${row.strike}${row.side}`)).toEqual(["54000CE", "54300CE", "54300PE", "54900CE"]);
  });
});
