import { describe, expect, it } from "vitest";
import {
  buildLadder,
  chartLevelsFromZones,
  levelShortLabel,
  zoneChartLabel,
  confluenceText,
  excludesZero,
  familyLabel,
  formatCalendarDate,
  formatDifference,
  formatDistance,
  formatPrice,
  formatShare,
  formatZoneRange,
  sheetFreshness,
  type SheetLevel,
  type SheetZone,
} from "./levels-view";

function zone(centre: number, referencePrice: number, overrides: Partial<SheetZone> = {}): SheetZone {
  return {
    low: centre, high: centre, centre, levels: [], families: ["PIVOT"], confluence: 1,
    position: centre > referencePrice ? "ABOVE" : centre < referencePrice ? "BELOW" : "AT",
    distancePoints: centre - referencePrice,
    distancePct: Number((((centre - referencePrice) / referencePrice) * 100).toFixed(2)),
    ...overrides,
  };
}

describe("buildLadder", () => {
  it("lists zones from the highest price down and marks the close between the zones above and below it", () => {
    const rows = buildLadder([zone(23_000, 23_050), zone(23_300, 23_050), zone(23_150, 23_050), zone(22_800, 23_050)], 23_050);
    expect(rows.map((row) => (row.kind === "ZONE" ? row.zone.centre : "CLOSE"))).toEqual([23_300, 23_150, "CLOSE", 23_000, 22_800]);
  });

  it("marks the close at the bottom when every zone is above it, and at the top when every zone is below it", () => {
    expect(buildLadder([zone(23_300, 23_050), zone(23_200, 23_050)], 23_050).at(-1)?.kind).toBe("REFERENCE");
    expect(buildLadder([zone(22_900, 23_050), zone(22_800, 23_050)], 23_050)[0].kind).toBe("REFERENCE");
  });

  it("puts the marker just after a zone that contains the close", () => {
    const containing = zone(23_050, 23_050, { low: 23_040, high: 23_060, position: "AT" });
    const rows = buildLadder([zone(23_300, 23_050), containing, zone(22_900, 23_050)], 23_050);
    expect(rows.map((row) => (row.kind === "ZONE" ? row.zone.centre : "CLOSE"))).toEqual([23_300, 23_050, "CLOSE", 22_900]);
  });

  it("shows just the marker when there are no zones", () => {
    expect(buildLadder([], 23_050)).toEqual([{ kind: "REFERENCE", price: 23_050 }]);
  });
});

describe("wording", () => {
  it("formats prices in Indian grouping with two decimals", () => {
    expect(formatPrice(123_456.5)).toBe("1,23,456.50");
  });

  it("shows a single level as a price and a cluster as a range", () => {
    expect(formatZoneRange(zone(23_000, 23_050))).toBe("23,000.00");
    expect(formatZoneRange(zone(23_010, 23_050, { low: 23_000, high: 23_020 }))).toBe("23,000.00 - 23,020.00");
  });

  it("gives the distance from the previous close with its sign", () => {
    expect(formatDistance(zone(23_170, 23_050))).toBe("+120 pts (+0.52%)");
    expect(formatDistance(zone(22_990, 23_050))).toBe("-60 pts (-0.26%)");
    expect(formatDistance(zone(23_050, 23_050))).toBe("at the close");
  });

  it("says how many kinds of source meet in a zone", () => {
    expect(confluenceText(zone(23_000, 23_050))).toBe("single source");
    expect(confluenceText(zone(23_000, 23_050, { confluence: 3 }))).toBe("3 sources");
  });

  it("names the families and falls back to the raw key", () => {
    expect(familyLabel("OI_WALL")).toBe("Option OI wall");
    expect(familyLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("freshness", () => {
  it("formats a calendar date without time-zone drift", () => {
    expect(formatCalendarDate("2026-11-03")).toBe("Tue 3 Nov");
  });

  it("tells today's sheet from an older one", () => {
    expect(sheetFreshness("2026-11-03", "2026-11-03")).toEqual({ state: "TODAY", text: "Sheet for today, Tue 3 Nov." });
    expect(sheetFreshness("2026-11-03", "2026-11-04").state).toBe("OLD");
    expect(sheetFreshness("2026-11-03", "2026-11-04").text).toContain("not today");
    expect(sheetFreshness("2026-11-05", "2026-11-04").state).toBe("UPCOMING");
  });
});

describe("history numbers", () => {
  it("formats shares and differences in percentage points", () => {
    expect(formatShare(0.5769)).toBe("57.7%");
    expect(formatShare(null)).toBe("n/a");
    expect(formatDifference({ difference: 0.0192, lower: -0.0319, upper: 0.0703 })).toBe("+1.9 (-3.2 to +7.0)");
    expect(formatDifference({ difference: null, lower: null, upper: null })).toBe("n/a");
  });

  it("flags only an interval that excludes zero", () => {
    expect(excludesZero({ lower: -0.03, upper: 0.07 })).toBe(false);
    expect(excludesZero({ lower: 0.01, upper: 0.09 })).toBe(true);
    expect(excludesZero({ lower: -0.09, upper: -0.01 })).toBe(true);
    expect(excludesZero({ lower: null, upper: null })).toBe(false);
  });
});

function level(key: string, family: SheetLevel["family"], price: number, label = key): SheetLevel {
  return { key, family, price, label };
}

describe("chart line labels", () => {
  it("shortens the known keys and keeps R/S levels and round numbers readable", () => {
    expect(levelShortLabel({ key: "pdh", label: "Previous day high" })).toBe("PDH");
    expect(levelShortLabel({ key: "pdc", label: "Previous day close" })).toBe("Close");
    expect(levelShortLabel({ key: "r2", label: "R2" })).toBe("R2");
    expect(levelShortLabel({ key: "s3", label: "S3" })).toBe("S3");
    expect(levelShortLabel({ key: "pivot", label: "Pivot" })).toBe("P");
    expect(levelShortLabel({ key: "call-oi-wall", label: "Highest call open interest" })).toBe("Call OI");
    expect(levelShortLabel({ key: "round-23500", label: "Round 23500" })).toBe("23,500");
    expect(levelShortLabel({ key: "week-high", label: "Previous week high" })).toBe("Wk high");
  });

  it("falls back to the full label for a key it does not know", () => {
    expect(levelShortLabel({ key: "something-new", label: "Something new" })).toBe("Something new");
  });

  it("names a zone by its first two lines and counts the rest", () => {
    const lines = [level("pdh", "PRIOR_DAY", 1), level("r1", "PIVOT", 1), level("round-100", "ROUND_NUMBER", 1), level("range-high", "RANGE_5D", 1)];
    expect(zoneChartLabel({ levels: lines.slice(0, 1) })).toBe("PDH");
    expect(zoneChartLabel({ levels: lines.slice(0, 2) })).toBe("PDH · R1");
    expect(zoneChartLabel({ levels: lines })).toBe("PDH · R1 +2");
  });
});

describe("chartLevelsFromZones", () => {
  const last = 23_000;
  const at = (centre: number, levels: SheetLevel[], confluence = levels.length > 1 ? 2 : 1): SheetZone =>
    zone(centre, last, { levels, families: ["PIVOT"], confluence });

  it("keeps the nearest zones on each side and drops the rest", () => {
    const zones = [23_020, 23_040, 23_060, 23_080, 22_980, 22_960, 22_940].map((c) => at(c, [level(`l${c}`, "PIVOT", c)]));
    const lines = chartLevelsFromZones(zones, last, { perSide: 2 });
    expect(lines.map((l) => l.price)).toEqual([22_960, 22_980, 23_020, 23_040]);
  });

  it("drops a zone farther than the maximum distance from price", () => {
    const zones = [at(23_100, [level("a", "PIVOT", 23_100)]), at(24_000, [level("b", "PIVOT", 24_000)])];
    expect(chartLevelsFromZones(zones, last, { maxDistancePct: 3 }).map((l) => l.price)).toEqual([23_100]);
  });

  it("marks a zone with two kinds of source as strong and the zone holding the previous close as the close line", () => {
    const zones = [
      at(23_300, [level("r1", "PIVOT", 23_300), level("round-23300", "ROUND_NUMBER", 23_300)]),
      at(23_050, [level("pdc", "PRIOR_DAY", 23_050)]),
      at(22_900, [level("s1", "PIVOT", 22_900)]),
    ];
    const lines = chartLevelsFromZones(zones, last);
    expect(lines.map((l) => [l.price, l.strong, l.kind])).toEqual([
      [22_900, false, "ZONE"],
      [23_050, false, "CLOSE"],
      [23_300, true, "ZONE"],
    ]);
    expect(lines[2].label).toBe("R1 · 23,300");
  });

  it("draws nothing for an unusable last price", () => {
    expect(chartLevelsFromZones([at(23_100, [level("a", "PIVOT", 23_100)])], Number.NaN)).toEqual([]);
    expect(chartLevelsFromZones([at(23_100, [level("a", "PIVOT", 23_100)])], 0)).toEqual([]);
  });
});
