import { describe, expect, it } from "vitest";
import { XAUUSD_OANDA_PROFILE, getNewYorkParts } from "./instrument-profile.js";

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
});
