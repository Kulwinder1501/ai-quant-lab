import { describe, expect, it } from "vitest";
import {
  buildOiHistoryChart,
  CONTRACT_PALETTE,
  METRIC_LABELS,
  oiHistoryQuery,
  type OiHistoryAvailable,
  type OiHistoryContractSeries,
} from "./build-oi-history-chart";

const T = (hhmm: string) => `2026-10-12T${hhmm}:00.000Z`; // UTC; the builder only needs ordering

function obs(at: string, underlyingValue: number | null = 22_500) {
  return { observedAt: at, kind: "INTRADAY" as const, underlyingValue, contractsObserved: 62 };
}

function point(oi: number | null, close: number | null, snap: number | null, present = true) {
  return { present, openInterest: oi, changeVsPreviousClose: close, changeVsPreviousSnapshot: snap };
}

function contract(
  strikePrice: number,
  optionType: "CE" | "PE",
  points: ReturnType<typeof point>[],
): OiHistoryContractSeries {
  return { strikePrice, optionType, previousCloseOpenInterest: 1_000, baselineConsistent: true, points };
}

function payload(overrides: Partial<OiHistoryAvailable> = {}): OiHistoryAvailable {
  return {
    available: true,
    underlyingSymbol: "NIFTY50",
    sessionDate: "2026-10-12",
    sessionTimezone: "Asia/Kolkata",
    expiryDate: "2026-10-27",
    oiUnit: "units (Fyers oi; not lots)",
    contractSelection: "DEFAULT",
    availableSessions: [],
    preOpen: null,
    observations: [obs(T("03:53")), obs(T("04:11")), obs(T("04:23"))],
    collectionGaps: [],
    contracts: [],
    totals: {
      rule: "fixed set",
      strikesUsed: [22_400, 22_500],
      strikesExcluded: 3,
      previousCloseCalls: 1_000,
      previousClosePuts: 2_000,
      points: [
        { calls: 1_100, puts: 1_900, putCallRatio: 1_900 / 1_100, callsChangeVsPreviousClose: 100, putsChangeVsPreviousClose: -100 },
        { calls: 1_300, puts: 1_800, putCallRatio: 1_800 / 1_300, callsChangeVsPreviousClose: 300, putsChangeVsPreviousClose: -200 },
        { calls: 1_250, puts: 1_850, putCallRatio: 1_850 / 1_250, callsChangeVsPreviousClose: 250, putsChangeVsPreviousClose: -150 },
      ],
    },
    selectableStrikes: [22_400, 22_500],
    ...overrides,
  };
}

describe("buildOiHistoryChart: totals", () => {
  it("plots level with previous-close baselines and carries the put/call ratio per row", () => {
    const model = buildOiHistoryChart(payload(), { mode: "totals", metric: "level" });
    expect(model.series.map((s) => s.key)).toEqual(["calls", "puts"]);
    expect(model.rows.map((r) => r.values.calls)).toEqual([1_100, 1_300, 1_250]);
    expect(model.rows.map((r) => r.values.puts)).toEqual([1_900, 1_800, 1_850]);
    expect(model.rows[0]!.putCallRatio).toBeCloseTo(1_900 / 1_100, 10);
    expect(model.baselines.map((b) => b.value)).toEqual([1_000, 2_000]);
    expect(model.signed).toBe(false);
  });

  it("plots change vs previous close with no baselines and a zero line", () => {
    const model = buildOiHistoryChart(payload(), { mode: "totals", metric: "changeVsPreviousClose" });
    expect(model.rows.map((r) => r.values.calls)).toEqual([100, 300, 250]);
    expect(model.rows.map((r) => r.values.puts)).toEqual([-100, -200, -150]);
    expect(model.baselines).toEqual([]);
    expect(model.signed).toBe(true);
  });

  it("derives change vs previous snapshot from the fixed-set totals, with no value for the first snapshot", () => {
    const model = buildOiHistoryChart(payload(), { mode: "totals", metric: "changeVsPreviousSnapshot" });
    expect(model.rows.map((r) => r.values.calls)).toEqual([null, 200, -50]);
    expect(model.rows.map((r) => r.values.puts)).toEqual([null, -100, 50]);
  });

  it("explains why there is nothing to plot rather than drawing an empty chart", () => {
    const unavailable = buildOiHistoryChart(
      payload({ totals: { unavailable: "No strike is present on both sides in every snapshot." } }),
      { mode: "totals", metric: "level" },
    );
    expect(unavailable.rows).toEqual([]);
    expect(unavailable.emptyReason).toContain("every snapshot");

    const none = buildOiHistoryChart(payload({ observations: [] }), { mode: "totals", metric: "level" });
    expect(none.emptyReason).toContain("pre-open");
  });
});

describe("buildOiHistoryChart: contracts", () => {
  const contracts = [
    contract(22_500, "CE", [point(1_100, 100, null), point(null, null, null), point(1_250, 250, null)]),
    contract(22_500, "PE", [point(1_900, -100, null), point(1_800, -200, -100), point(1_850, -150, 50)]),
  ];

  it("keeps an unreported OI as a gap and never as zero", () => {
    const model = buildOiHistoryChart(payload({ contracts }), { mode: "contracts", metric: "level" });
    expect(model.rows.map((r) => r.values["22500CE"])).toEqual([1_100, null, 1_250]);
    expect(model.rows.map((r) => r.values["22500PE"])).toEqual([1_900, 1_800, 1_850]);
  });

  it("labels series by strike and side and assigns stable colours", () => {
    const model = buildOiHistoryChart(payload({ contracts }), { mode: "contracts", metric: "level" });
    expect(model.series.map((s) => s.label)).toEqual(["22500 CE", "22500 PE"]);
    expect(model.series.map((s) => s.side)).toEqual(["call", "put"]);
    expect(model.series.map((s) => s.color)).toEqual([CONTRACT_PALETTE[0], CONTRACT_PALETTE[1]]);
  });

  it("selects the requested change metric", () => {
    const close = buildOiHistoryChart(payload({ contracts }), { mode: "contracts", metric: "changeVsPreviousClose" });
    expect(close.rows.map((r) => r.values["22500PE"])).toEqual([-100, -200, -150]);
    const snap = buildOiHistoryChart(payload({ contracts }), { mode: "contracts", metric: "changeVsPreviousSnapshot" });
    expect(snap.rows.map((r) => r.values["22500PE"])).toEqual([null, -100, 50]);
  });

  it("reports an empty selection instead of an empty chart, and survives a short points array", () => {
    expect(buildOiHistoryChart(payload({ contracts: [] }), { mode: "contracts", metric: "level" }).emptyReason)
      .toContain("No contracts");
    const short = buildOiHistoryChart(
      payload({ contracts: [contract(22_500, "CE", [point(1_100, 100, null)])] }),
      { mode: "contracts", metric: "level" },
    );
    expect(short.rows.map((r) => r.values["22500CE"])).toEqual([1_100, null, null]);
  });
});

describe("buildOiHistoryChart: collection gaps", () => {
  it("cuts the lines inside a gap with a null break row instead of bridging it", () => {
    const model = buildOiHistoryChart(
      payload({
        observations: [obs(T("03:53")), obs(T("04:11")), obs(T("04:41"))],
        collectionGaps: [{ from: T("04:11"), to: T("04:41"), minutes: 30 }],
        totals: {
          rule: "fixed set", strikesUsed: [22_500], strikesExcluded: 0, previousCloseCalls: 10, previousClosePuts: 20,
          points: [
            { calls: 11, puts: 21, putCallRatio: 1.9, callsChangeVsPreviousClose: 1, putsChangeVsPreviousClose: 1 },
            { calls: 12, puts: 22, putCallRatio: 1.8, callsChangeVsPreviousClose: 2, putsChangeVsPreviousClose: 2 },
            { calls: 13, puts: 23, putCallRatio: 1.7, callsChangeVsPreviousClose: 3, putsChangeVsPreviousClose: 3 },
          ],
        },
      }),
      { mode: "totals", metric: "level" },
    );

    expect(model.rows).toHaveLength(4);
    const breakRow = model.rows.find((r) => r.isGapBreak)!;
    expect(breakRow.values).toEqual({ calls: null, puts: null });
    expect(breakRow.underlying).toBeNull();
    // The break sits between the two observations that bound the gap.
    expect(breakRow.t).toBeGreaterThan(Date.parse(T("04:11")));
    expect(breakRow.t).toBeLessThan(Date.parse(T("04:41")));
    expect(model.gapAreas).toEqual([{ x1: Date.parse(T("04:11")), x2: Date.parse(T("04:41")), minutes: 30 }]);
    // Rows stay in time order.
    expect(model.rows.map((r) => r.t)).toEqual([...model.rows.map((r) => r.t)].sort((a, b) => a - b));
  });

  it("adds no break rows when the session has no gaps", () => {
    const model = buildOiHistoryChart(payload(), { mode: "totals", metric: "level" });
    expect(model.rows.some((r) => r.isGapBreak)).toBe(false);
    expect(model.gapAreas).toEqual([]);
  });
});

describe("maxAbs", () => {
  it("is the largest absolute plotted value, counting baselines, so an axis can pick one unit", () => {
    // Calls peak at 1,300 and puts at 1,900; the puts baseline (2,000) is the largest thing on screen.
    const level = buildOiHistoryChart(payload(), { mode: "totals", metric: "level" });
    expect(level.maxAbs).toBe(2_000);
    // Change metric: no baselines, and a negative value counts by magnitude.
    const change = buildOiHistoryChart(payload(), { mode: "totals", metric: "changeVsPreviousClose" });
    expect(change.maxAbs).toBe(300);
  });

  it("ignores gap-break rows and nulls, and is zero when there is nothing to plot", () => {
    expect(buildOiHistoryChart(payload({ observations: [] }), { mode: "totals", metric: "level" }).maxAbs).toBe(0);
    const model = buildOiHistoryChart(
      payload({ contracts: [contract(22_500, "CE", [point(null, null, null), point(null, null, null), point(null, null, null)])] }),
      { mode: "contracts", metric: "level" },
    );
    expect(model.maxAbs).toBe(0);
  });
});

describe("labels", () => {
  it("names the two changes differently so day-over-day is never read as intraday", () => {
    expect(METRIC_LABELS.changeVsPreviousClose).not.toBe(METRIC_LABELS.changeVsPreviousSnapshot);
    expect(METRIC_LABELS.changeVsPreviousClose).toContain("prev. close");
    expect(METRIC_LABELS.changeVsPreviousSnapshot).toContain("snapshot");
  });

  it("carries the unit on every y-axis label", () => {
    for (const metric of ["level", "changeVsPreviousClose", "changeVsPreviousSnapshot"] as const) {
      expect(buildOiHistoryChart(payload(), { mode: "totals", metric }).yAxisLabel).toContain("not lots");
    }
  });
});

describe("oiHistoryQuery", () => {
  it("omits optional parameters so the server applies its defaults", () => {
    expect(oiHistoryQuery({ underlying: "NIFTY50", expiry: "", sessionDate: "", contracts: null })).toBe("underlying=NIFTY50");
  });

  it("sends the session, expiry and contracts when chosen", () => {
    const query = new URLSearchParams(oiHistoryQuery({
      underlying: "BANKNIFTY",
      expiry: "2026-10-27",
      sessionDate: "2026-10-23",
      contracts: [{ strikePrice: 22_500, optionType: "CE" }, { strikePrice: 22_500, optionType: "PE" }],
    }));
    expect(query.get("underlying")).toBe("BANKNIFTY");
    expect(query.get("expiry")).toBe("2026-10-27");
    expect(query.get("date")).toBe("2026-10-23");
    expect(query.get("contracts")).toBe("22500CE,22500PE");
  });

  it("never sends an empty contracts list, which would silently restore the defaults", () => {
    const query = new URLSearchParams(oiHistoryQuery({ underlying: "NIFTY50", expiry: "", sessionDate: "", contracts: [] }));
    expect(query.has("contracts")).toBe(false);
  });
});
