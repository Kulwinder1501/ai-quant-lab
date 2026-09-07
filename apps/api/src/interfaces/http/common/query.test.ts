import { describe, expect, it } from "vitest";
import { InvalidHttpQueryError, parseIstCalendarDateRange } from "./query.js";

describe("parseIstCalendarDateRange", () => {
  it("maps one IST calendar day to an exact half-open UTC range", () => {
    const range = parseIstCalendarDateRange("2026-08-20", "date");

    expect(range.from.toISOString()).toBe("2026-08-19T18:30:00.000Z");
    expect(range.toExclusive.toISOString()).toBe("2026-08-20T18:30:00.000Z");
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(() => parseIstCalendarDateRange("20-08-2026", "date")).toThrow(InvalidHttpQueryError);
    expect(() => parseIstCalendarDateRange("2026-02-31", "date")).toThrow(/valid calendar date/);
  });
});
