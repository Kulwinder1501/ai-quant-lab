import { describe, expect, it } from "vitest";
import {
  XAUUSD_OANDA_PROFILE,
  NSE_IST_PROFILE,
  getNewYorkParts,
  instrumentProfileForSymbol,
  sessionDateKey,
} from "./instrument-profile.js";
import { istSessionDate } from "./trading-session.js";

describe("XAUUSD_OANDA_PROFILE (G1a Session Date Resolver)", () => {
  it("resolves NY time parts accurately across DST boundary", () => {
    // July 15 (EDT UTC-4): 22:00 UTC is 18:00 EDT (session open)
    const edtDate = new Date("2026-07-15T22:00:00.000Z");
    const nyEdt = getNewYorkParts(edtDate);
    expect(nyEdt.hour).toBe(18);
    expect(nyEdt.month).toBe(7);
    expect(nyEdt.day).toBe(15);

    // Jan 15 (EST UTC-5): 23:00 UTC is 18:00 EST (session open)
    const estDate = new Date("2026-01-15T23:00:00.000Z");
    const nyEst = getNewYorkParts(estDate);
    expect(nyEst.hour).toBe(18);
    expect(nyEst.month).toBe(1);
    expect(nyEst.day).toBe(15);
  });

  it("advances session date to next calendar day at 18:00 NY time", () => {
    // Sunday 18:05 NY time (2026-07-12 22:05 UTC)
    // Sunday 18:00 opens the Monday session (2026-07-13)
    const sunEvening = new Date("2026-07-12T22:05:00.000Z");
    const sessionDate = XAUUSD_OANDA_PROFILE.sessionDateResolver(sunEvening);
    expect(sessionDate.toISOString().slice(0, 10)).toBe("2026-07-13");
  });

  it("keeps same calendar day session date for trade prior to 17:00 NY time", () => {
    // Monday 14:00 NY time (2026-07-13 18:00 UTC)
    const monAfternoon = new Date("2026-07-13T18:00:00.000Z");
    const sessionDate = XAUUSD_OANDA_PROFILE.sessionDateResolver(monAfternoon);
    expect(sessionDate.toISOString().slice(0, 10)).toBe("2026-07-13");
  });

  it("identifies 17:00-18:00 NY daily break Mon-Thu", () => {
    // Tuesday 17:30 NY time (2026-07-14 21:30 UTC)
    const tueBreak = new Date("2026-07-14T21:30:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.isDailyBreak(tueBreak)).toBe(true);
    expect(XAUUSD_OANDA_PROFILE.isSessionActive(tueBreak)).toBe(false);

    // Tuesday 16:30 NY time (2026-07-14 20:30 UTC) -> active
    const tueActive = new Date("2026-07-14T20:30:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.isDailyBreak(tueActive)).toBe(false);
    expect(XAUUSD_OANDA_PROFILE.isSessionActive(tueActive)).toBe(true);
  });

  it("identifies weekend market close", () => {
    // Saturday 12:00 NY time (2026-07-18 16:00 UTC)
    const satNoon = new Date("2026-07-18T16:00:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.isSessionActive(satNoon)).toBe(false);

    // Sunday 16:00 NY time (2026-07-19 20:00 UTC) -> before 18:00 open
    const sunClosed = new Date("2026-07-19T20:00:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.isSessionActive(sunClosed)).toBe(false);
  });

  it("resolves the NY-local 18:00 session-date boundary identically in EDT and EST (G1 DST wiring)", () => {
    /*
     * This is the behaviour a fixed-UTC-offset resolver (what `istSessionDate` would give gold if
     * it were wired in unchanged) cannot reproduce: the boundary is always 18:00 *NY local time*,
     * which is 22:00 UTC in summer (EDT, UTC-4) and 23:00 UTC in winter (EST, UTC-5).
     */
    // EDT: Monday 18:05 NY = 22:05 UTC -> rolls to Tuesday's session date.
    const edtRolled = new Date("2026-07-13T22:05:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.sessionDateResolver(edtRolled).toISOString().slice(0, 10)).toBe("2026-07-14");

    // EST: Monday 18:05 NY = 23:05 UTC -> rolls to Tuesday's session date.
    const estRolled = new Date("2026-01-12T23:05:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.sessionDateResolver(estRolled).toISOString().slice(0, 10)).toBe("2026-01-13");

    // EST: the SAME 22:05 UTC instant that rolled over in EDT is only 17:05 NY in winter (EST) --
    // before the 18:00 open, so it must NOT roll over yet. A DST-unaware (fixed UTC-4) resolver
    // would read this as 18:05 NY and roll it over incorrectly.
    const estNotYetRolled = new Date("2026-01-12T22:05:00.000Z");
    expect(XAUUSD_OANDA_PROFILE.sessionDateResolver(estNotYetRolled).toISOString().slice(0, 10)).toBe("2026-01-12");
  });
});

describe("NSE_IST_PROFILE (G1 wiring)", () => {
  it("matches istSessionDate byte-for-byte across a representative sample of instants", () => {
    const samples = [
      // Ordinary intraday instants, well clear of the IST midnight boundary.
      new Date("2026-01-05T04:00:00.000Z"), // 09:30 IST
      new Date("2026-01-05T10:00:00.000Z"), // 15:30 IST
      // The week used by continuous-weekly-session.test.ts's XAU fix, for consistency -- India
      // has no DST, so these carry no special meaning for NSE beyond being a shared reference week.
      new Date("2026-09-18T12:00:00.000Z"),
      new Date("2026-09-23T12:00:00.000Z"),
      new Date("2026-09-23T18:35:00.000Z"), // close to IST midnight: 2026-09-24 00:05 IST
      new Date("2026-09-23T18:29:00.000Z"), // just before IST midnight: 2026-09-23 23:59 IST
      // A real US DST transition (2026-11-01) -- must not move NSE's date at all, unlike gold's.
      new Date("2026-10-31T20:00:00.000Z"),
      new Date("2026-11-01T20:00:00.000Z"),
      // Year boundary, to catch an off-by-one in the UTC-date shift.
      new Date("2025-12-31T19:00:00.000Z"), // 2026-01-01 00:30 IST
      new Date("2025-12-31T18:00:00.000Z"), // 2025-12-31 23:30 IST
    ];

    for (const instant of samples) {
      const resolved = NSE_IST_PROFILE.sessionDateResolver(instant).toISOString().slice(0, 10);
      expect(resolved).toBe(istSessionDate(instant));
    }
  });

  it("has no intraday break and no DST sensitivity, unlike XAUUSD_OANDA_PROFILE", () => {
    expect(NSE_IST_PROFILE.isDailyBreak(new Date("2026-07-14T21:30:00.000Z"))).toBe(false);
  });
});

describe("instrumentProfileForSymbol (G1 wiring)", () => {
  it("resolves XAU_USD to the OANDA gold profile", () => {
    expect(instrumentProfileForSymbol("XAU_USD")).toBe(XAUUSD_OANDA_PROFILE);
  });

  it("defaults every other symbol to the NSE IST profile", () => {
    expect(instrumentProfileForSymbol("NIFTY50")).toBe(NSE_IST_PROFILE);
    expect(instrumentProfileForSymbol("BANKNIFTY")).toBe(NSE_IST_PROFILE);
    expect(instrumentProfileForSymbol("SOME_UNKNOWN_SYMBOL")).toBe(NSE_IST_PROFILE);
  });
});

describe("sessionDateKey (G1 wiring)", () => {
  it("formats a profile's resolved Date as YYYY-MM-DD, matching istSessionDate for NSE", () => {
    const instant = new Date("2026-09-23T12:00:00.000Z");
    expect(sessionDateKey(NSE_IST_PROFILE, instant)).toBe(istSessionDate(instant));
  });

  it("uses the profile's own resolver, so XAU_USD differs from NSE on the same instant", () => {
    // 2026-07-13T19:00:00Z is 15:00 NY (EDT) -- before gold's 18:00 open, so XAU's session date
    // stays 2026-07-13 -- but it is already 00:30 IST the next calendar day, so NSE's session date
    // has rolled to 2026-07-14. `sessionDateKey` defers entirely to whichever profile it is given,
    // which is exactly why the two disagree here.
    const instant = new Date("2026-07-13T19:00:00.000Z");
    expect(sessionDateKey(XAUUSD_OANDA_PROFILE, instant)).toBe("2026-07-13");
    expect(sessionDateKey(NSE_IST_PROFILE, instant)).toBe("2026-07-14");
    expect(sessionDateKey(NSE_IST_PROFILE, instant)).toBe(istSessionDate(instant));
  });
});
