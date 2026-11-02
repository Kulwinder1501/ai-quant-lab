import { describe, expect, it } from "vitest";
import {
  buildLadder,
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
