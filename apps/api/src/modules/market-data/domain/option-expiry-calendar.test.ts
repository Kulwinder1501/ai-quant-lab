import { describe, expect, it } from "vitest";
import {
  assertCalendarStorable,
  resolveListedExpiry,
  type OptionExpiryCalendar,
} from "./option-expiry-calendar.js";

/** BANKNIFTY as the provider actually reports it: monthly only, every expiry a Tuesday. */
function bankniftyCalendar(overrides: Partial<OptionExpiryCalendar> = {}): OptionExpiryCalendar {
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "FYERS",
    observedAt: new Date("2026-08-04T13:53:00.000Z"),
    expiries: [
      { expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" },
      { expiryDate: new Date("2026-09-29T10:00:00.000Z"), expiryKind: "MONTHLY" },
      { expiryDate: new Date("2026-10-27T10:00:00.000Z"), expiryKind: "MONTHLY" },
    ],
    ...overrides,
  };
}

describe("resolveListedExpiry", () => {
  it("accepts an expiry the provider lists", () => {
    const resolution = resolveListedExpiry(
      bankniftyCalendar(),
      new Date("2026-08-25T10:00:00.000Z"),
      "BANKNIFTY",
    );
    expect(resolution.usable).toBe(true);
    if (resolution.usable) {
      expect(resolution.expiryKind).toBe("MONTHLY");
      expect(resolution.expiryDate.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    }
  });

  it("refuses the phantom expiry that was actually traded twice", () => {
    // The real case: BANKNIFTY 2026-08-04 was booked, priced, and settled. It never traded.
    const resolution = resolveListedExpiry(
      bankniftyCalendar(),
      new Date("2026-08-04T10:00:00.000Z"),
      "BANKNIFTY",
    );
    expect(resolution.usable).toBe(false);
    if (!resolution.usable) {
      expect(resolution.reason).toBe("EXPIRY_NOT_LISTED");
      expect(resolution.explanation).toContain("does not list an expiry on 2026-08-04");
      // The fact that made it look plausible has to be stated, not left to inference.
      expect(resolution.explanation).toContain("no weekly series");
      expect(resolution.explanation).toContain("2026-08-25 (MONTHLY)");
    }
  });

  it("does not claim 'no weekly series' for an underlying that has one", () => {
    const nifty = bankniftyCalendar({
      underlyingSymbol: "NIFTY50",
      expiries: [
        { expiryDate: new Date("2026-08-11T10:00:00.000Z"), expiryKind: "WEEKLY" },
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" },
      ],
    });
    const resolution = resolveListedExpiry(nifty, new Date("2026-08-12T10:00:00.000Z"), "NIFTY50");
    expect(resolution.usable).toBe(false);
    if (!resolution.usable) expect(resolution.explanation).not.toContain("no weekly series");
  });

  it("matches on the calendar date, so any time of day on expiry day resolves", () => {
    const resolution = resolveListedExpiry(
      bankniftyCalendar(),
      new Date("2026-08-25T04:30:00.000Z"),
      "BANKNIFTY",
    );
    expect(resolution.usable).toBe(true);
    // The contract's own settlement instant wins over whatever the caller passed.
    if (resolution.usable) expect(resolution.expiryDate.toISOString()).toBe("2026-08-25T10:00:00.000Z");
  });

  it("refuses when no calendar has been collected, rather than assuming the expiry is fine", () => {
    const resolution = resolveListedExpiry(null, new Date("2026-08-25T10:00:00.000Z"), "SBIN");
    expect(resolution.usable).toBe(false);
    if (!resolution.usable) {
      expect(resolution.reason).toBe("NO_CALENDAR");
      expect(resolution.explanation).toContain("data:collect:option-chain");
    }
  });

  it("treats an empty expiry list as no calendar", () => {
    const resolution = resolveListedExpiry(
      bankniftyCalendar({ expiries: [] }),
      new Date("2026-08-25T10:00:00.000Z"),
      "BANKNIFTY",
    );
    expect(resolution.usable).toBe(false);
    if (!resolution.usable) expect(resolution.reason).toBe("NO_CALENDAR");
  });

  it("refuses an invalid requested date", () => {
    const resolution = resolveListedExpiry(bankniftyCalendar(), new Date(NaN), "BANKNIFTY");
    expect(resolution.usable).toBe(false);
  });

  it("names the observation time so a stale calendar can be recognised", () => {
    const resolution = resolveListedExpiry(
      bankniftyCalendar(),
      new Date("2026-11-24T10:00:00.000Z"),
      "BANKNIFTY",
    );
    expect(resolution.usable).toBe(false);
    if (!resolution.usable) expect(resolution.explanation).toContain("2026-08-04T13:53:00.000Z");
  });
});

describe("assertCalendarStorable", () => {
  it("accepts a real calendar", () => {
    expect(() => assertCalendarStorable(bankniftyCalendar())).not.toThrow();
  });

  it("refuses an empty list, which would later read as 'this underlying lists nothing'", () => {
    expect(() => assertCalendarStorable(bankniftyCalendar({ expiries: [] })))
      .toThrow(/came back empty/);
  });

  it("refuses a repeated expiry, since one of the two flags must be wrong", () => {
    expect(() => assertCalendarStorable(bankniftyCalendar({
      expiries: [
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" },
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "WEEKLY" },
      ],
    }))).toThrow(/repeats 2026-08-25/);
  });

  it("refuses an invalid expiry date and a missing symbol", () => {
    expect(() => assertCalendarStorable(bankniftyCalendar({
      expiries: [{ expiryDate: new Date(NaN), expiryKind: "MONTHLY" }],
    }))).toThrow(/invalid date/);
    expect(() => assertCalendarStorable(bankniftyCalendar({ underlyingSymbol: "  " })))
      .toThrow(/underlying symbol/);
  });
});
