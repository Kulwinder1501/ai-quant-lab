import { describe, expect, it } from "vitest";
import {
  isWithinSession,
  istInstant,
  istSessionDate,
  resolveTradingSession,
  type NonRegularSessionWindow,
} from "./trading-session.js";
import {
  knownNseNonRegularSessionMap,
  NSE_CASH_CLOSE_IST_MINUTE,
  NSE_DERIVATIVES_CLOSE_IST_MINUTE,
  NSE_REGULAR_SESSION_OPEN_IST_MINUTE,
} from "../../market-data/domain/nse-non-regular-sessions.js";

const CASH_SHAPE = {
  opensAtIstMinute: NSE_REGULAR_SESSION_OPEN_IST_MINUTE,
  closesAtIstMinute: NSE_CASH_CLOSE_IST_MINUTE,
};
const DERIVATIVES_SHAPE = {
  opensAtIstMinute: NSE_REGULAR_SESSION_OPEN_IST_MINUTE,
  closesAtIstMinute: NSE_DERIVATIVES_CLOSE_IST_MINUTE,
};
const NO_HOLIDAYS: ReadonlySet<string> = new Set();
const NO_SPECIALS: ReadonlyMap<string, NonRegularSessionWindow> = new Map();

const resolve = (sessionDate: string, overrides: Partial<Parameters<typeof resolveTradingSession>[0]> = {}) =>
  resolveTradingSession({
    sessionDate,
    regularShape: CASH_SHAPE,
    holidays: NO_HOLIDAYS,
    nonRegularSessions: NO_SPECIALS,
    ...overrides,
  });

describe("IST conversions", () => {
  it("names a session by its IST date, not the UTC one", () => {
    // 09:15 IST is 03:45 UTC the same day, but 15:30 IST on the 31st is still the 31st in IST while a
    // naive UTC read of an early-morning instant lands on the previous date.
    expect(istSessionDate(new Date("2026-08-31T03:45:00.000Z"))).toBe("2026-08-31");
    expect(istSessionDate(new Date("2026-08-30T18:35:00.000Z"))).toBe("2026-08-31");
  });

  it("round-trips a minute-of-day through the instant it denotes", () => {
    const opensAt = istInstant("2026-08-31", 9 * 60 + 15);

    expect(opensAt.toISOString()).toBe("2026-08-31T03:45:00.000Z");
    expect(istSessionDate(opensAt)).toBe("2026-08-31");
  });

  it("refuses a malformed date or an out-of-range minute", () => {
    expect(() => istInstant("31-08-2026", 555)).toThrow(/YYYY-MM-DD/);
    expect(() => istInstant("2026-08-31", 1441)).toThrow(/\[0, 1440\]/);
    expect(() => istInstant("2026-08-31", 9.5)).toThrow(/integer/);
  });
});

describe("regular sessions", () => {
  it("uses the segment's own closing bell", () => {
    // Cash and equity derivatives ring different bells, and conflating them meant a 15:15 signal with
    // a 30-minute hold scheduled an exit into a market the code believed was shut.
    const cash = resolve("2026-08-31");
    const derivatives = resolve("2026-08-31", { regularShape: DERIVATIVES_SHAPE });

    expect(cash.closesAt?.toISOString()).toBe("2026-08-31T10:00:00.000Z"); // 15:30 IST
    expect(derivatives.closesAt?.toISOString()).toBe("2026-08-31T10:10:00.000Z"); // 15:40 IST
    expect(cash.kind).toBe("REGULAR");
  });

  it("closes on a weekend and on a holiday, and says which", () => {
    const saturday = resolve("2026-08-29");
    const holiday = resolve("2026-08-31", { holidays: new Set(["2026-08-31"]) });

    expect(saturday.kind).toBe("CLOSED");
    expect(saturday.reason).toBe("Weekend");
    expect(saturday.opensAt).toBeNull();
    expect(holiday.kind).toBe("CLOSED");
    expect(holiday.reason).toBe("Exchange holiday");
  });

  it("refuses a shape that closes before it opens", () => {
    expect(() => resolve("2026-08-31", {
      regularShape: { opensAtIstMinute: 930, closesAtIstMinute: 555 },
    })).toThrow(/close after it opens/);
  });
});

describe("non-regular sessions take precedence over the weekday rule", () => {
  const specials = knownNseNonRegularSessionMap();

  it("opens the four weekend sittings the weekday rule would have closed", () => {
    /*
     * Measured, not hypothetical. Each of these carries 105-750 one-minute bars per instrument on the
     * stored tape while `NseMarketSession` reports it closed, because tradability was decided from the
     * weekday. None is in `nse_holidays`, so no holiday-list maintenance would have helped.
     */
    const cases = [
      { date: "2023-11-12", open: "18:15", close: "19:15" }, // Sunday, Muhurat evening
      { date: "2024-01-20", open: "09:15", close: "15:30" }, // Saturday, full day
      { date: "2024-03-02", open: "09:15", close: "12:30" }, // Saturday, half day
      { date: "2026-02-01", open: "09:15", close: "15:30" }, // Sunday, Budget
    ];

    for (const { date, open, close } of cases) {
      const session = resolve(date, { nonRegularSessions: specials });
      expect(session.kind, date).toBe("NON_REGULAR");
      expect(session.opensAt, date).not.toBeNull();
      const minutesOf = (instant: Date): string =>
        new Date(instant.getTime() + 5.5 * 60 * 60_000).toISOString().slice(11, 16);
      expect(minutesOf(session.opensAt!), date).toBe(open);
      expect(minutesOf(session.closesAt!), date).toBe(close);
    }
  });

  it("replaces the regular window on a weekday that had no regular trading", () => {
    /*
     * The opposite error, and the more dangerous one: 2024-11-01 and 2025-10-21 are ordinary weekdays
     * with no regular session at all, so the calendar reported a 09:15-15:30 window against a tape
     * holding only an evening or afternoon sitting. Anything reasoning about "is the market open" got
     * a confident wrong answer for six and a half hours.
     */
    const diwaliEvening = resolve("2024-11-01", { nonRegularSessions: specials });
    const diwaliAfternoon = resolve("2025-10-21", { nonRegularSessions: specials });

    expect(diwaliEvening.kind).toBe("NON_REGULAR");
    expect(diwaliEvening.opensAt?.toISOString()).toBe("2024-11-01T12:30:00.000Z"); // 18:00 IST
    expect(diwaliAfternoon.opensAt?.toISOString()).toBe("2025-10-21T08:15:00.000Z"); // 13:45 IST
    // Not the regular open, which is what the calendar produced before.
    expect(diwaliEvening.opensAt?.toISOString()).not.toBe("2024-11-01T03:45:00.000Z");
  });

  it("wins over a holiday entry as well as over the weekday", () => {
    // The exchange announcing a sitting settles the question. A date listed as a holiday *and*
    // declared as a special session traded.
    const session = resolve("2025-10-21", {
      nonRegularSessions: specials,
      holidays: new Set(["2025-10-21"]),
    });

    expect(session.kind).toBe("NON_REGULAR");
  });

  it("carries the circular reference and the window's provenance", () => {
    const session = resolve("2025-10-21", { nonRegularSessions: specials });

    expect(session.circularReference).toBe("NSE/CMTR/70319");
    expect(session.windowProvenance).toBe("CIRCULAR");
    expect(resolve("2024-01-20", { nonRegularSessions: specials }).windowProvenance)
      .toBe("OBSERVED_FROM_TAPE");
  });

  it("keeps every catalogued session resolvable and well-formed", () => {
    for (const [date, declared] of specials) {
      const session = resolve(date, { nonRegularSessions: specials });
      expect(session.kind, date).toBe("NON_REGULAR");
      expect(session.closesAt!.getTime(), date).toBeGreaterThan(session.opensAt!.getTime());
      expect(declared.circularReference, date).toMatch(/^NSE\//);
    }
    expect(specials.size).toBe(8);
  });
});

describe("isWithinSession", () => {
  const session = resolve("2026-08-31");

  it("is half-open, so the bar opening at the close is outside", () => {
    /*
     * The convention that keeps an over-run detectable. 2025-10-21 carries one bar opening at 14:45,
     * past its announced 14:45 close; a closed interval would absorb it into the session and the
     * discrepancy would disappear.
     */
    expect(isWithinSession(istInstant("2026-08-31", 9 * 60 + 15), session)).toBe(true);
    expect(isWithinSession(istInstant("2026-08-31", 15 * 60 + 29), session)).toBe(true);
    expect(isWithinSession(istInstant("2026-08-31", 15 * 60 + 30), session)).toBe(false);
    expect(isWithinSession(istInstant("2026-08-31", 9 * 60 + 14), session)).toBe(false);
  });

  it("is false for every instant on a closed day", () => {
    const closed = resolve("2026-08-29");

    expect(isWithinSession(istInstant("2026-08-29", 12 * 60), closed)).toBe(false);
  });

  it("flags the observed over-run on 2025-10-21 rather than absorbing it", () => {
    // The extra bar is real: 61 bars per instrument against the 60 the announced window allows.
    const muhurat = resolve("2025-10-21", { nonRegularSessions: knownNseNonRegularSessionMap() });

    expect(isWithinSession(istInstant("2025-10-21", 14 * 60 + 44), muhurat)).toBe(true);
    expect(isWithinSession(istInstant("2025-10-21", 14 * 60 + 45), muhurat)).toBe(false);
  });
});
