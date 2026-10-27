import { describe, expect, it } from "vitest";
import {
  buildSplitBars,
  liveSideSplitQuery,
  percentText,
  splitHeadline,
  totalsText,
  type LiveSideSplitAvailable,
} from "./live-side-split-view";

function payload(rows: LiveSideSplitAvailable["rows"]): LiveSideSplitAvailable {
  const totals = rows.reduce((sum, row) => ({ buy: sum.buy + row.buy, sell: sum.sell + row.sell, unknown: sum.unknown + row.unknown }), { buy: 0, sell: 0, unknown: 0 });
  const total = totals.buy + totals.sell + totals.unknown;
  return {
    available: true,
    underlying: "NIFTY50",
    sessionDate: "2026-10-28",
    symbol: "NIFTY26NOVFUT",
    estimated: true,
    rowPoints: 5,
    rows,
    totals: { ...totals, total },
    unknownShare: total > 0 ? totals.unknown / total : null,
    messages: 100,
    advances: 40,
    counterResets: 0,
    // 09:20 and 09:50 IST.
    since: "2026-10-28T03:50:00.000Z",
    last: "2026-10-28T04:20:00.000Z",
    definitions: { estimate: "e", placement: "p", sideRule: "s", scope: "c" },
  };
}

describe("liveSideSplitQuery", () => {
  it("sends the index and only a chosen row height", () => {
    expect(liveSideSplitQuery({ underlying: "NIFTY50", rowPoints: null })).toBe("underlying=NIFTY50");
    expect(liveSideSplitQuery({ underlying: "BANKNIFTY", rowPoints: 20 })).toBe("underlying=BANKNIFTY&rowPoints=20");
  });
});

describe("buildSplitBars", () => {
  const rows = [
    { low: 25_000, high: 25_005, buy: 60, sell: 20, unknown: 20 }, // 100
    { low: 25_010, high: 25_015, buy: 0, sell: 0, unknown: 50 }, // 50
    { low: 25_005, high: 25_010, buy: 10, sell: 30, unknown: 60 }, // 100
  ];

  it("lists the highest price first and measures lengths against the busiest row", () => {
    const bars = buildSplitBars(payload(rows));
    expect(bars.map((bar) => bar.label)).toEqual(["25010–25015", "25005–25010", "25000–25005"]);
    expect(bars.map((bar) => bar.lengthPct)).toEqual([50, 100, 100]);
  });

  it("gives each part as a share of its own row, adding to 100, with unknown kept as its own part", () => {
    const [top, middle, bottom] = buildSplitBars(payload(rows));
    expect([top!.buyPct, top!.sellPct, top!.unknownPct]).toEqual([0, 0, 100]);
    expect([middle!.buyPct, middle!.sellPct, middle!.unknownPct]).toEqual([10, 30, 60]);
    expect([bottom!.buyPct, bottom!.sellPct, bottom!.unknownPct]).toEqual([60, 20, 20]);
    for (const bar of [top!, middle!, bottom!]) expect(bar.buyPct + bar.sellPct + bar.unknownPct).toBeCloseTo(100, 9);
  });

  it("has no bars for no rows and never divides by zero", () => {
    expect(buildSplitBars(payload([]))).toEqual([]);
    const [bar] = buildSplitBars(payload([{ low: 1, high: 2, buy: 0, sell: 0, unknown: 0 }]));
    expect(bar).toMatchObject({ lengthPct: 0, buyPct: 0, sellPct: 0, unknownPct: 0 });
  });
});

describe("percentText", () => {
  it("rounds, shows a dash for no value, and does not call a small non-zero share zero", () => {
    expect(percentText(0.364)).toBe("36%");
    expect(percentText(null)).toBe("—");
    expect(percentText(0.001)).toBe("<1%");
    expect(percentText(0)).toBe("0%");
    expect(percentText(1)).toBe("100%");
  });
});

describe("headline and totals", () => {
  const data = payload([{ low: 25_000, high: 25_005, buy: 60, sell: 20, unknown: 20 }]);

  it("states the contract, the IST time counting began, the volume and the unknown share", () => {
    expect(splitHeadline(data)).toBe("NIFTY50 futures NIFTY26NOVFUT · counted since 09:20 IST (last 09:50) · 100 units · side unknown for 20%");
  });

  it("says counting has not started when there is no first time", () => {
    expect(splitHeadline({ ...data, since: null, last: null })).toContain("counting not started");
  });

  it("gives buy, sell and unknown as shares of the whole", () => {
    expect(totalsText(data)).toBe("buy 60% · sell 20% · unknown 20%");
    expect(totalsText(payload([]))).toBe("");
  });
});
