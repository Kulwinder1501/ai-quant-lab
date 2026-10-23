import { describe, expect, it } from "vitest";
import {
  buildOiHistory,
  istMinuteOfDay,
  MAX_OI_HISTORY_CONTRACTS,
  observationKindOf,
  parseOiHistoryQuery,
  selectDefaultContracts,
  type OiHistoryRow,
} from "./oi-history.js";

/** 2026-10-12 is a Monday. IST = UTC + 5:30, so 09:23 IST = 03:53Z. */
function at(istHour: number, istMinute: number): Date {
  const minutes = istHour * 60 + istMinute - 330;
  return new Date(Date.UTC(2026, 9, 12, 0, 0, 0) + minutes * 60_000);
}

function row(
  when: Date,
  strikePrice: number,
  optionType: "CE" | "PE",
  openInterest: number | null,
  previousOpenInterest: number | null,
  underlyingValue: number | null = 22_500,
): OiHistoryRow {
  return { observedAt: when, strikePrice, optionType, openInterest, previousOpenInterest, underlyingValue };
}

describe("pre-open classification", () => {
  it("treats snapshots before 09:15 IST as carryover and 09:15 onward as intraday", () => {
    expect(observationKindOf(at(9, 11))).toBe("PRE_OPEN_CARRYOVER");
    expect(observationKindOf(at(9, 14))).toBe("PRE_OPEN_CARRYOVER");
    expect(observationKindOf(at(9, 15))).toBe("INTRADAY");
    expect(observationKindOf(at(9, 23))).toBe("INTRADAY");
  });

  it("reads the IST clock from a UTC instant, including across the UTC date line", () => {
    expect(istMinuteOfDay(new Date("2026-10-12T03:41:00.000Z"))).toBe(9 * 60 + 11);
    // 20:00Z is 01:30 IST the next day.
    expect(istMinuteOfDay(new Date("2026-10-12T20:00:00.000Z"))).toBe(90);
  });
});

describe("buildOiHistory", () => {
  it("keeps the 09:11 carryover out of every series and reports it separately", () => {
    const result = buildOiHistory(
      [
        row(at(9, 11), 22_500, "CE", 1_000, 1_000),
        row(at(9, 23), 22_500, "CE", 1_100, 1_000),
        row(at(9, 41), 22_500, "CE", 1_250, 1_000),
      ],
      { contracts: [{ strikePrice: 22_500, optionType: "CE" }] },
    );

    expect(result.preOpen?.kind).toBe("PRE_OPEN_CARRYOVER");
    expect(result.observations).toHaveLength(2);
    expect(result.observations.every((o) => o.kind === "INTRADAY")).toBe(true);
    // Aligned to intraday observations only: no flat first point at the previous close.
    expect(result.contracts[0]!.points.map((p) => p.openInterest)).toEqual([1_100, 1_250]);
  });

  it("measures change against the previous close and, separately, the previous snapshot", () => {
    const result = buildOiHistory(
      [
        row(at(9, 23), 22_500, "CE", 1_100, 1_000),
        row(at(9, 41), 22_500, "CE", 1_250, 1_000),
        row(at(9, 53), 22_500, "CE", 1_200, 1_000),
      ],
      { contracts: [{ strikePrice: 22_500, optionType: "CE" }] },
    );
    const series = result.contracts[0]!;
    expect(series.previousCloseOpenInterest).toBe(1_000);
    expect(series.baselineConsistent).toBe(true);
    expect(series.points.map((p) => p.changeVsPreviousClose)).toEqual([100, 250, 200]);
    // The first intraday point has no earlier intraday snapshot to compare with.
    expect(series.points.map((p) => p.changeVsPreviousSnapshot)).toEqual([null, 150, -50]);
  });

  it("keeps a missing contract and a null OI as null, and a real zero as zero", () => {
    const result = buildOiHistory(
      [
        row(at(9, 23), 22_500, "CE", 0, 500),
        row(at(9, 23), 22_600, "CE", null, 500),
        row(at(9, 41), 22_600, "CE", 700, 500),
      ],
      {
        contracts: [
          { strikePrice: 22_500, optionType: "CE" },
          { strikePrice: 22_600, optionType: "CE" },
        ],
      },
    );
    const [zero, unreported] = result.contracts;
    expect(zero!.points[0]).toMatchObject({ present: true, openInterest: 0, changeVsPreviousClose: -500 });
    // Strike 22,500 left the window at 09:41: absent, not zero.
    expect(zero!.points[1]).toMatchObject({ present: false, openInterest: null, changeVsPreviousClose: null });
    expect(unreported!.points[0]).toMatchObject({ present: true, openInterest: null, changeVsPreviousClose: null });
    // Previous snapshot had a null OI, so the snapshot-to-snapshot change is unknown, not 700.
    expect(unreported!.points[1]!.changeVsPreviousSnapshot).toBeNull();
  });

  it("does not bridge a snapshot where the contract was absent", () => {
    const result = buildOiHistory(
      [
        row(at(9, 23), 22_500, "CE", 1_000, 900),
        row(at(9, 41), 22_600, "CE", 5, 5),
        row(at(9, 53), 22_500, "CE", 1_300, 900),
      ],
      { contracts: [{ strikePrice: 22_500, optionType: "CE" }] },
    );
    const points = result.contracts[0]!.points;
    expect(points.map((p) => p.present)).toEqual([true, false, true]);
    // 300 would be the change across the gap; it must not be reported as a snapshot-to-snapshot change.
    expect(points[2]!.changeVsPreviousSnapshot).toBeNull();
    expect(points[2]!.changeVsPreviousClose).toBe(400);
  });

  it("flags a previous-close baseline that changes within the session", () => {
    const result = buildOiHistory(
      [row(at(9, 23), 22_500, "CE", 1_100, 1_000), row(at(9, 41), 22_500, "CE", 1_150, 1_020)],
      { contracts: [{ strikePrice: 22_500, optionType: "CE" }] },
    );
    expect(result.contracts[0]!.baselineConsistent).toBe(false);
  });

  it("totals only strikes present on both sides in every snapshot, so a sliding window is not an OI change", () => {
    // The window holds 3 strikes and slides up by one each snapshot. Summing whatever is present would
    // add 400 of call OI at 09:41 when the strike 22,400 entered, and drop 100 when 22,200 left.
    const rows = [
      // 09:23: strikes 22,200 / 22,300 / 22,400
      ...[22_200, 22_300, 22_400].flatMap((s) => [
        row(at(9, 23), s, "CE", 100, 100),
        row(at(9, 23), s, "PE", 200, 200),
      ]),
      // 09:41: strikes 22,300 / 22,400 / 22,500 (unchanged OI on the shared ones)
      ...[22_300, 22_400, 22_500].flatMap((s) => [
        row(at(9, 41), s, "CE", s === 22_500 ? 400 : 100, s === 22_500 ? 400 : 100),
        row(at(9, 41), s, "PE", 200, 200),
      ]),
    ];
    const result = buildOiHistory(rows, { contracts: [] });
    const totals = result.totals as Exclude<typeof result.totals, { unavailable: string } | null>;

    expect(totals.strikesUsed).toEqual([22_300, 22_400]);
    expect(totals.strikesExcluded).toBe(2);
    expect(totals.points.map((p) => p.calls)).toEqual([200, 200]);
    expect(totals.points.map((p) => p.callsChangeVsPreviousClose)).toEqual([0, 0]);
    expect(totals.points[0]!.putCallRatio).toBe(2);
  });

  it("reports totals as unavailable, with the reason, when no strike is in every snapshot", () => {
    const result = buildOiHistory(
      [row(at(9, 23), 22_200, "CE", 1, 1), row(at(9, 23), 22_200, "PE", 1, 1), row(at(9, 41), 22_300, "CE", 1, 1), row(at(9, 41), 22_300, "PE", 1, 1)],
      { contracts: [] },
    );
    expect(result.totals).toEqual({ unavailable: expect.stringContaining("every snapshot") });
  });

  it("excludes a strike whose previous close was never reported rather than treating it as zero", () => {
    const result = buildOiHistory(
      [
        row(at(9, 23), 22_300, "CE", 100, null),
        row(at(9, 23), 22_300, "PE", 100, 100),
        row(at(9, 23), 22_400, "CE", 100, 100),
        row(at(9, 23), 22_400, "PE", 100, 100),
      ],
      { contracts: [] },
    );
    const totals = result.totals as Exclude<typeof result.totals, { unavailable: string } | null>;
    expect(totals.strikesUsed).toEqual([22_400]);
  });

  it("reports a collection gap past 20 minutes and none for the normal 12/18 minute cadence", () => {
    const rows = [
      row(at(9, 23), 22_500, "CE", 1, 1),
      row(at(9, 41), 22_500, "CE", 1, 1), // 18 min: normal
      row(at(10, 11), 22_500, "CE", 1, 1), // 30 min: a missed run
      row(at(10, 23), 22_500, "CE", 1, 1), // 12 min: normal
    ];
    const gaps = buildOiHistory(rows, { contracts: [] }).collectionGaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ minutes: 30, from: at(9, 41).toISOString(), to: at(10, 11).toISOString() });
  });

  it("offers the strikes of the last intraday snapshot for selection", () => {
    const result = buildOiHistory(
      [
        row(at(9, 23), 22_000, "CE", 1, 1),
        row(at(9, 41), 22_400, "CE", 1, 1),
        row(at(9, 41), 22_300, "PE", 1, 1),
      ],
      { contracts: [] },
    );
    expect(result.selectableStrikes).toEqual([22_300, 22_400]);
  });

  it("returns an empty, well-formed result for a session with no intraday snapshot", () => {
    const result = buildOiHistory([row(at(9, 11), 22_500, "CE", 1, 1)], {
      contracts: [{ strikePrice: 22_500, optionType: "CE" }],
    });
    expect(result.observations).toEqual([]);
    expect(result.preOpen).not.toBeNull();
    expect(result.contracts[0]!.points).toEqual([]);
    expect(result.totals).toEqual({ unavailable: expect.any(String) });
  });
});

describe("selectDefaultContracts", () => {
  it("picks the ATM call and put plus the heaviest-OI strike on each side, without duplicates", () => {
    const when = at(9, 41);
    const rows = [
      row(when, 22_400, "CE", 100, 90, 22_510),
      row(when, 22_500, "CE", 500, 400, 22_510),
      row(when, 22_600, "CE", 900, 800, 22_510),
      row(when, 22_400, "PE", 700, 600, 22_510),
      row(when, 22_500, "PE", 300, 250, 22_510),
      row(when, 22_600, "PE", 50, 40, 22_510),
    ];
    const chosen = selectDefaultContracts(rows);
    expect(chosen).toEqual([
      { strikePrice: 22_500, optionType: "CE" },
      { strikePrice: 22_500, optionType: "PE" },
      { strikePrice: 22_600, optionType: "CE" },
      { strikePrice: 22_400, optionType: "PE" },
    ]);
  });

  it("returns nothing when the session has no intraday snapshot", () => {
    expect(selectDefaultContracts([row(at(9, 11), 22_500, "CE", 1, 1)])).toEqual([]);
    expect(selectDefaultContracts([])).toEqual([]);
  });
});

describe("parseOiHistoryQuery", () => {
  const none = { underlying: undefined, expiry: undefined, date: undefined, contracts: undefined };

  it("defaults to NIFTY50 with no date, expiry or contracts", () => {
    expect(parseOiHistoryQuery(none)).toEqual({
      ok: true,
      value: { underlyingSymbol: "NIFTY50", expiryDate: null, sessionDate: null, contracts: [] },
    });
  });

  it("parses contracts case-insensitively and removes duplicates", () => {
    const parsed = parseOiHistoryQuery({ ...none, contracts: "22500ce, 22500PE,22500CE" });
    expect(parsed).toMatchObject({
      ok: true,
      value: { contracts: [{ strikePrice: 22_500, optionType: "CE" }, { strikePrice: 22_500, optionType: "PE" }] },
    });
  });

  it("rejects malformed contracts, impossible dates and an oversized request", () => {
    expect(parseOiHistoryQuery({ ...none, contracts: "22500" }).ok).toBe(false);
    expect(parseOiHistoryQuery({ ...none, contracts: "ABCCE" }).ok).toBe(false);
    expect(parseOiHistoryQuery({ ...none, date: "2026-02-31" }).ok).toBe(false);
    expect(parseOiHistoryQuery({ ...none, expiry: "27-10-2026" }).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_OI_HISTORY_CONTRACTS + 1 }, (_, i) => `${22_000 + i * 50}CE`).join(",");
    expect(parseOiHistoryQuery({ ...none, contracts: tooMany }).ok).toBe(false);
  });

  it("accepts a real date and rejects an underlying that is not a plain symbol", () => {
    expect(parseOiHistoryQuery({ ...none, date: "2026-10-23" }).ok).toBe(true);
    expect(parseOiHistoryQuery({ ...none, underlying: "nifty50; drop" }).ok).toBe(false);
  });
});
