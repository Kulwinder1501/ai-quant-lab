import { describe, expect, it } from "vitest";
import { NseMarketSession } from "./nse-market-session.js";

/** A 2026 Monday, mid-session. */
const midSession = new Date("2026-08-24T06:00:00.000Z");

describe("NseMarketSession cash windows", () => {
  it("still opens 09:15 and closes 15:30 IST, unchanged by the segment work", () => {
    // Pinned against the literal UTC instants the previous implementation hardcoded
    // (`Date.UTC(y, m, d, 3, 45)` and `Date.UTC(y, m, d, 10, 0)`). The arithmetic was rewritten to
    // derive both from minute constants, and a silent drift here would move every candle boundary.
    const session = new NseMarketSession().getSession(midSession)!;

    expect(session.opensAt.toISOString()).toBe("2026-08-24T03:45:00.000Z");
    expect(session.closesAt.toISOString()).toBe("2026-08-24T10:00:00.000Z");
    expect(session.segment).toBe("CASH");
  });

  it("defaults to CASH, so no existing caller silently gains ten minutes", () => {
    // The default is deliberately not the widest window: extending the day by default would make a
    // missing option quote look like a data gap rather than a closed market.
    expect(new NseMarketSession().getSession(midSession)!.closesAt.toISOString())
      .toBe("2026-08-24T10:00:00.000Z");
  });

  it("returns null on weekends and injected holidays regardless of segment", () => {
    const saturday = new Date("2026-08-22T06:00:00.000Z");
    const holiday = new NseMarketSession(["2026-08-24"], "EQUITY_DERIVATIVES");

    expect(new NseMarketSession().getSession(saturday)).toBeNull();
    expect(holiday.getSession(midSession)).toBeNull();
  });
});

describe("NseMarketSession derivatives windows", () => {
  it("closes 15:40 IST for equity derivatives on and after the effective date", () => {
    const session = new NseMarketSession([], "EQUITY_DERIVATIVES").getSession(midSession)!;

    expect(session.closesAt.toISOString()).toBe("2026-08-24T10:10:00.000Z");
    expect(session.segment).toBe("EQUITY_DERIVATIVES");
  });

  it("does not widen sessions before the effective date", () => {
    // Retroactively extending a historical day would invent ten minutes of quotes that could not
    // have existed, and any coverage audit over that window would then read as a data gap.
    const before = new Date("2026-07-31T06:00:00.000Z");
    const session = new NseMarketSession([], "EQUITY_DERIVATIVES").getSession(before)!;

    expect(session.closesAt.toISOString()).toBe("2026-07-31T10:00:00.000Z");
  });

  it("treats the effective date itself as the first widened session", () => {
    const onTheDay = new Date("2026-08-03T06:00:00.000Z");

    expect(new NseMarketSession([], "EQUITY_DERIVATIVES").getSession(onTheDay)!.closesAt.toISOString())
      .toBe("2026-08-03T10:10:00.000Z");
  });

  it("lets a caller ask per call without rebuilding the calendar", () => {
    const calendar = new NseMarketSession();

    expect(calendar.getSession(midSession, "EQUITY_DERIVATIVES")!.closesAt.toISOString())
      .toBe("2026-08-24T10:10:00.000Z");
    expect(calendar.getSession(midSession)!.closesAt.toISOString())
      .toBe("2026-08-24T10:00:00.000Z");
  });

  it("reports 15:35 as open for derivatives and shut for cash", () => {
    const between = new Date("2026-08-24T10:05:00.000Z");
    const calendar = new NseMarketSession();

    expect(calendar.isOpen(between)).toBe(false);
    expect(calendar.isOpen(between, "EQUITY_DERIVATIVES")).toBe(true);
  });
});

describe("NseMarketSession input validation", () => {
  it("refuses an unknown segment rather than falling back to cash", () => {
    expect(() => new NseMarketSession([], "COMMODITY" as never)).toThrow(/Unknown NSE segment/);
  });

  it("refuses an invalid timestamp rather than deriving a window from NaN", () => {
    // Previously this produced a window of Invalid Dates, and every downstream comparison against
    // it silently returned false -- a closed market and a corrupt clock looked identical.
    expect(() => new NseMarketSession().getSession(new Date(Number.NaN)))
      .toThrow(/valid timestamp/);
  });
});
