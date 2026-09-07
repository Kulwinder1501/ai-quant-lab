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

/** Minutes-of-IST-day rendering, for asserting a window without hand-converting offsets. */
const istClock = (instant: Date): string =>
  new Date(instant.getTime() + 5.5 * 60 * 60_000).toISOString().slice(11, 16);

describe("NseMarketSession non-regular sessions", () => {
  /*
   * Adoption of the platform calendar. Before it, tradability was decided from the weekday plus a
   * holiday set and the non-regular catalogue carried only dates, which was wrong on six of the eight
   * known non-regular sessions in two opposite directions.
   */
  it("opens a weekend sitting the weekday rule reported closed", () => {
    /*
     * The crash this fixes, not merely a wrong number. `run-scalp-research-harness.ts` throws
     * "No NSE session for completed candle" when getSession returns null, so on the next weekend
     * special session it would have failed mid-capture on a day holding 1,500 bars.
     */
    const sundayBudget = new NseMarketSession().getSession(new Date("2026-02-01T06:00:00.000Z"));

    expect(sundayBudget).not.toBeNull();
    expect(sundayBudget!.kind).toBe("NON_REGULAR");
    expect(sundayBudget!.reason).toBe("Sunday Union Budget live session");
    expect(istClock(sundayBudget!.opensAt)).toBe("09:15");
    expect(istClock(sundayBudget!.closesAt)).toBe("15:30");
  });

  it("gives a Saturday half-day its announced 12:30 close, not the regular bell", () => {
    const halfDay = new NseMarketSession().getSession(new Date("2024-03-02T05:00:00.000Z"));

    expect(halfDay!.kind).toBe("NON_REGULAR");
    expect(istClock(halfDay!.closesAt)).toBe("12:30");
  });

  it("replaces the regular window on a weekday that had no regular trading", () => {
    /*
     * The more dangerous direction. 2024-11-01 and 2025-10-21 are ordinary weekdays whose only
     * trading was an evening or afternoon Muhurat sitting, and the calendar previously reported a
     * confident 09:15-15:30 window for both.
     */
    const evening = new NseMarketSession().getSession(new Date("2024-11-01T13:00:00.000Z"));
    const afternoon = new NseMarketSession().getSession(new Date("2025-10-21T08:30:00.000Z"));

    expect(istClock(evening!.opensAt)).toBe("18:00");
    expect(istClock(evening!.closesAt)).toBe("19:00");
    expect(istClock(afternoon!.opensAt)).toBe("13:45");
    expect(istClock(afternoon!.closesAt)).toBe("14:45");
  });

  it("reports the market shut at midday on a Muhurat-only weekday", () => {
    // Previously isOpen returned true here, for six and a half hours, on a day whose tape holds
    // nothing before 18:00.
    const session = new NseMarketSession();

    expect(session.isOpen(new Date("2024-11-01T06:00:00.000Z"))).toBe(false); // 11:30 IST
    expect(session.isOpen(new Date("2024-11-01T13:00:00.000Z"))).toBe(true);  // 18:30 IST
  });

  it("still closes an ordinary weekend and an ordinary holiday", () => {
    // The weekday and holiday rules survive; only a *declared* session overrides them.
    const session = new NseMarketSession(["2026-08-31"]);

    expect(session.getSession(new Date("2026-08-29T06:00:00.000Z"))).toBeNull(); // Saturday
    expect(session.getSession(new Date("2026-08-31T06:00:00.000Z"))).toBeNull(); // holiday
  });

  it("marks a regular session REGULAR with no reason", () => {
    const regular = new NseMarketSession().getSession(midSession);

    expect(regular!.kind).toBe("REGULAR");
    expect(regular!.reason).toBeNull();
  });

  it("keeps the dated derivatives bell through the delegation", () => {
    // The one NSE fact the platform never learns: the bell moved on 2026-08-03, and a historical
    // window must not be widened retroactively.
    const derivatives = new NseMarketSession([], "EQUITY_DERIVATIVES");

    expect(istClock(derivatives.getSession(new Date("2026-08-24T06:00:00.000Z"))!.closesAt)).toBe("15:40");
    expect(istClock(derivatives.getSession(new Date("2026-07-31T06:00:00.000Z"))!.closesAt)).toBe("15:30");
  });

  it("aligns candleWindow to the non-regular open, not to 09:15", () => {
    // A 5m lattice anchored at the regular open would be off by the whole morning on an evening
    // sitting, so every bar boundary would land mid-bar.
    const window = new NseMarketSession().candleWindow(new Date("2024-11-01T12:37:00.000Z"), "5m");

    expect(window).not.toBeNull();
    expect(istClock(window!.openTime)).toBe("18:05");
    expect(istClock(window!.closeTime)).toBe("18:10");
  });
});
