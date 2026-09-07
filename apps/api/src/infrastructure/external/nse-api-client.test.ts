import { describe, expect, it } from "vitest";
import { parseNseDate, parseNseNumber } from "./nse-api-client.js";

describe("parseNseNumber", () => {
  // The reason this function exists. NSE renders these values for display, so
  // they arrive with thousands separators, and bare parseFloat("12,345.67")
  // returns 12 — a silent three-order-of-magnitude error that flowed into a
  // NUMERIC column and then into a model feature.
  it("reads thousands separators rather than truncating at the first comma", () => {
    expect(parseNseNumber("12,345.67")).toBe(12345.67);
    expect(parseNseNumber("1,23,456.78")).toBe(123456.78); // Indian grouping
  });

  it("reads plain, signed, and currency-prefixed numbers", () => {
    expect(parseNseNumber("1234.5")).toBe(1234.5);
    expect(parseNseNumber("-987.25")).toBe(-987.25);
    expect(parseNseNumber("₹ 4,500.00")).toBe(4500);
    expect(parseNseNumber(1234.5)).toBe(1234.5);
  });

  it("reads accounting-style parenthesised negatives", () => {
    expect(parseNseNumber("(1,234.50)")).toBe(-1234.5);
  });

  // Returning null rather than NaN is the point: NaN reaches the driver and either
  // throws deep inside a query or lands in the column, and either way the caller
  // never got the chance to record the value as absent.
  it("returns null for anything it cannot read cleanly", () => {
    for (const value of ["", "  ", "-", "NA", "n/a", "abc", "1.2.3", "12-34", null, undefined, {}, Number.NaN]) {
      expect(parseNseNumber(value), `expected null for ${JSON.stringify(value)}`).toBeNull();
    }
  });

  it("keeps a genuine zero distinct from absent data", () => {
    expect(parseNseNumber("0")).toBe(0);
    expect(parseNseNumber("0.00")).toBe(0);
  });
});

describe("parseNseDate", () => {
  it("reads NSE's DD-Mon-YYYY session format at UTC midnight", () => {
    expect(parseNseDate("29-Jul-2026")?.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(parseNseDate("01-Jan-2026")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseNseDate("9-Dec-2025")?.toISOString()).toBe("2025-12-09T00:00:00.000Z");
  });

  it("tolerates the long month name and spaces NSE sometimes emits", () => {
    expect(parseNseDate("29-July-2026")?.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(parseNseDate("29 Jul 2026")?.toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });

  // Date.UTC rolls 31-Feb forward to 03-Mar without complaint, which would file a
  // session under a date that never traded.
  it("rejects impossible calendar dates instead of rolling them forward", () => {
    expect(parseNseDate("31-Feb-2026")).toBeNull();
    expect(parseNseDate("32-Jan-2026")).toBeNull();
    expect(parseNseDate("00-Jan-2026")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    for (const value of ["2026-07-29", "29-Xyz-2026", "", "today", null, undefined, 20260729]) {
      expect(parseNseDate(value), `expected null for ${JSON.stringify(value)}`).toBeNull();
    }
  });
});
