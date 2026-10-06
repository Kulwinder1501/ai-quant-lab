import { describe, expect, it } from "vitest";
import {
  INTRADAY_FLATTEN_TIMEFRAMES,
  SESSION_CLOSE_FLATTEN_IST_MINUTES,
  SESSION_ENTRY_CUTOFF_IST_MINUTES,
  isAtOrAfterSessionEntryCutoff,
  isAtOrAfterSessionCloseCutoff,
  istMinutesSinceMidnight,
  shouldFlattenAtSessionClose,
} from "./session-close.js";

/**
 * The 15:15 IST square-off boundary.
 *
 * Every instant here is written in UTC on purpose. The containers run UTC (`TZ` is unset), the
 * database stores UTC, and the bug this rule closes was a position whose stop resolved against the
 * *next session's* opening tick -- so the one thing these tests must not do is assume the process
 * clock and the exchange clock agree.
 */
describe("session close flatten", () => {
  it("reads the IST wall clock, not the process clock", () => {
    // 09:45 UTC is 15:15 IST. A process running UTC sees 09:45 and would not flatten.
    expect(istMinutesSinceMidnight(new Date("2026-09-03T09:45:00Z"))).toBe(15 * 60 + 15);
    expect(istMinutesSinceMidnight(new Date("2026-09-03T00:00:00Z"))).toBe(5 * 60 + 30);
  });

  it("does not fire a minute before the cutoff", () => {
    // 09:44 UTC = 15:14 IST.
    expect(isAtOrAfterSessionCloseCutoff(new Date("2026-09-03T09:44:00Z"))).toBe(false);
    expect(shouldFlattenAtSessionClose("5m", new Date("2026-09-03T09:44:00Z"))).toBe(false);
  });

  it("fires exactly at the cutoff", () => {
    expect(isAtOrAfterSessionCloseCutoff(new Date("2026-09-03T09:45:00Z"))).toBe(true);
    expect(shouldFlattenAtSessionClose("5m", new Date("2026-09-03T09:45:00Z"))).toBe(true);
  });

  it("keeps firing after the cutoff, including past the close", () => {
    // 10:01 UTC = 15:31 IST. A position still open after the bell must square off on the next
    // sweep rather than wait for a cutoff window that has already passed.
    expect(shouldFlattenAtSessionClose("5m", new Date("2026-09-03T10:01:00Z"))).toBe(true);
    // 09:29 UTC next morning = 14:59 IST: a *new* session, and below the cutoff again.
    expect(shouldFlattenAtSessionClose("5m", new Date("2026-09-04T09:29:00Z"))).toBe(false);
  });

  it("covers every timeframe the bots actually trade", () => {
    const atCutoff = new Date("2026-09-03T09:45:00Z");
    // The whole closed-trade record is 1m and 5m; both must be covered or the rule is decorative.
    expect(shouldFlattenAtSessionClose("1m", atCutoff)).toBe(true);
    expect(shouldFlattenAtSessionClose("5m", atCutoff)).toBe(true);
    expect(INTRADAY_FLATTEN_TIMEFRAMES).toContain("1m");
    expect(INTRADAY_FLATTEN_TIMEFRAMES).toContain("5m");
  });

  it("leaves a non-intraday position alone", () => {
    const atCutoff = new Date("2026-09-03T09:45:00Z");
    expect(shouldFlattenAtSessionClose("1d", atCutoff)).toBe(false);
    expect(shouldFlattenAtSessionClose("60m", atCutoff)).toBe(false);
  });

  it("holds a position whose timeframe is unknown", () => {
    // Null means the source bar is unknown, not that the holding period is short. Squaring off on
    // a guess is the same mistake as reading an absent coverage row as an empty one.
    expect(shouldFlattenAtSessionClose(null, new Date("2026-09-03T09:45:00Z"))).toBe(false);
  });

  it("refuses an invalid instant rather than defaulting to a boundary", () => {
    expect(() => istMinutesSinceMidnight(new Date("nonsense"))).toThrow(/invalid date/i);
  });

  it("pins the cutoff to 15:15 IST", () => {
    expect(SESSION_CLOSE_FLATTEN_IST_MINUTES).toBe(915);
  });
});

describe("session entry cutoff", () => {
  it("refuses a new entry from the cutoff onward", () => {
    expect(isAtOrAfterSessionEntryCutoff(new Date("2026-09-03T09:45:00Z"))).toBe(true);  // 15:15
    expect(isAtOrAfterSessionEntryCutoff(new Date("2026-09-03T09:50:00Z"))).toBe(true);  // 15:20
  });

  it("allows an entry a minute before it", () => {
    expect(isAtOrAfterSessionEntryCutoff(new Date("2026-09-03T09:44:00Z"))).toBe(false); // 15:14
  });

  it("would have refused both positions that carried overnight", () => {
    // Both were opened at 15:20 IST -- after the cutoff that now squares them off. Squaring off
    // without refusing the entry leaves a round trip of brokerage on a one-minute position.
    expect(isAtOrAfterSessionEntryCutoff(new Date("2026-08-20T09:50:00Z"))).toBe(true);
  });

  it("opens again next session", () => {
    expect(isAtOrAfterSessionEntryCutoff(new Date("2026-09-04T03:45:00Z"))).toBe(false); // 09:15
  });

  it("shares one minute with the square-off, so the two cannot drift apart", () => {
    // A gap between them is a window where the bot opens what the next sweep must close.
    expect(SESSION_ENTRY_CUTOFF_IST_MINUTES).toBe(SESSION_CLOSE_FLATTEN_IST_MINUTES);
  });
});
