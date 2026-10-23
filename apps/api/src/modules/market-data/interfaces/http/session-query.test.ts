import { describe, expect, it } from "vitest";
import { addDays, istDate, parseChoice, parseUnderlyingAndDate } from "./session-query.js";

describe("istDate", () => {
  it("reads the IST calendar day, not the UTC one, either side of midnight", () => {
    // 18:29Z is 23:59 IST the same day; 18:30Z is 00:00 IST the next.
    expect(istDate(new Date("2026-10-22T18:29:59.999Z"))).toBe("2026-10-22");
    expect(istDate(new Date("2026-10-22T18:30:00.000Z"))).toBe("2026-10-23");
    expect(istDate(new Date("2026-10-22T00:00:00.000Z"))).toBe("2026-10-22");
  });
});

describe("addDays", () => {
  it("moves across month, year and leap-day boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-10-22", -60)).toBe("2026-08-23");
  });

  it("returns a date unchanged for zero, and normalises an impossible one (which is how the parser spots it)", () => {
    expect(addDays("2026-10-22", 0)).toBe("2026-10-22");
    expect(addDays("2026-02-30", 0)).toBe("2026-03-02");
  });
});

describe("parseUnderlyingAndDate", () => {
  const now = new Date("2026-10-22T05:00:00.000Z");

  it("defaults the underlying to BANKNIFTY and leaves the date open", () => {
    expect(parseUnderlyingAndDate({ underlying: undefined, date: undefined }, now)).toEqual({ ok: true, underlying: "BANKNIFTY", date: null });
    expect(parseUnderlyingAndDate({ underlying: "  ", date: "  " }, now)).toEqual({ ok: true, underlying: "BANKNIFTY", date: null });
  });

  it("refuses text that is not a real calendar date, in every shape it might arrive", () => {
    for (const date of ["2026-13-01", "2026-02-30", "2026-10-9", "26-10-09", "2026/10/09", "2026-10-09T00:00:00Z", "today", "20261009"]) {
      expect(parseUnderlyingAndDate({ underlying: undefined, date }, now).ok, date).toBe(false);
    }
  });

  it("compares with today in IST: at 01:00 IST the UTC date is still yesterday", () => {
    const early = new Date("2026-10-21T19:30:00.000Z"); // 2026-10-22 01:00 IST
    expect(parseUnderlyingAndDate({ underlying: undefined, date: "2026-10-22" }, early).ok).toBe(true);
    expect(parseUnderlyingAndDate({ underlying: undefined, date: "2026-10-23" }, early)).toEqual({ ok: false, error: "`date` is in the future." });
  });
});

describe("parseChoice", () => {
  it("returns the fallback when nothing is given", () => {
    expect(parseChoice(undefined, [1, 2, 5], 2, "rowPoints")).toEqual({ ok: true, value: 2 });
    expect(parseChoice("  ", [1, 2, 5], 2, "rowPoints")).toEqual({ ok: true, value: 2 });
  });

  it("accepts a listed whole number and names the choices when refusing", () => {
    expect(parseChoice("5", [1, 2, 5], 2, "rowPoints")).toEqual({ ok: true, value: 5 });
    expect(parseChoice("3", [1, 2, 5], 2, "rowPoints")).toEqual({ ok: false, error: "`rowPoints` must be one of 1, 2, 5." });
  });

  it("refuses text that only starts like a number, or reads as one by coercion", () => {
    for (const text of ["5px", "5.0", "05e0", "+5", "-5", "0x5", "5 5"]) expect(parseChoice(text, [1, 2, 5], 2, "n").ok, text).toBe(false);
  });
});
