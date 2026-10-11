import { describe, expect, it } from "vitest";
import {
  OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES,
  buildOptionChainSignal,
  isWithinCashSession,
  selectNearestUnsettledExpiry,
} from "./option-chain-signal.js";

/** IST wall-clock -> UTC instant. */
function ist(date: string, time: string): Date {
  return new Date(new Date(`${date}T${time}.000Z`).getTime() - 330 * 60_000);
}

describe("selectNearestUnsettledExpiry", () => {
  const calendar = ["2026-09-29", "2026-09-22", "2026-10-06", "2026-10-13"];

  it("picks the earliest expiry, not the farthest (the 'roll' book is never the nearest)", () => {
    expect(selectNearestUnsettledExpiry(calendar, ist("2026-09-21", "10:00:00"))).toBe("2026-09-22");
  });

  it("keeps the expiry-day contract until its 15:30 IST settlement", () => {
    expect(selectNearestUnsettledExpiry(calendar, ist("2026-09-22", "15:25:00"))).toBe("2026-09-22");
  });

  it("rolls to the next expiry at 15:30 IST on expiry day (settled books no longer count)", () => {
    // A date-only test (expiry_date >= observed_at::date) kept returning 2026-09-22 here.
    expect(selectNearestUnsettledExpiry(calendar, ist("2026-09-22", "15:30:00"))).toBe("2026-09-29");
    expect(selectNearestUnsettledExpiry(calendar, ist("2026-09-22", "15:53:00"))).toBe("2026-09-29");
  });

  it("returns null when every listed expiry has settled or the calendar is empty", () => {
    expect(selectNearestUnsettledExpiry(calendar, ist("2026-10-13", "15:30:00"))).toBeNull();
    expect(selectNearestUnsettledExpiry([], ist("2026-09-21", "10:00:00"))).toBeNull();
  });

  it("ignores malformed dates and duplicates", () => {
    expect(selectNearestUnsettledExpiry(["nonsense", "2026-09-29", "2026-09-29"], ist("2026-09-21", "10:00:00")))
      .toBe("2026-09-29");
  });
});

describe("isWithinCashSession", () => {
  it("excludes a 09:11 pre-open poll and a 15:53 post-close poll", () => {
    expect(isWithinCashSession(ist("2026-09-22", "09:11:00"))).toBe(false);
    expect(isWithinCashSession(ist("2026-09-22", "15:53:00"))).toBe(false);
  });

  it("includes the 09:15:00 open through the 15:30:00 close, both inclusive", () => {
    expect(isWithinCashSession(ist("2026-09-22", "09:15:00"))).toBe(true);
    expect(isWithinCashSession(ist("2026-09-22", "12:00:00"))).toBe(true);
    expect(isWithinCashSession(ist("2026-09-22", "15:30:00"))).toBe(true);
    expect(isWithinCashSession(ist("2026-09-22", "15:30:01"))).toBe(false);
  });
});

describe("buildOptionChainSignal", () => {
  const decisionTime = ist("2026-09-22", "11:00:00");
  const base = {
    expiryDate: "2026-09-22",
    decisionTime,
    callOpenInterest: 100_000,
    putOpenInterest: 140_000,
    contracts: 40,
    contractsWithMissingOpenInterest: 0,
  };

  it("uses one 20-minute ceiling", () => {
    expect(OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES).toBe(20);
  });

  it("accepts an 18-minute-old snapshot: the slowest healthy poll of a 12/18-minute collector", () => {
    const signal = buildOptionChainSignal({
      ...base, observedAt: new Date(decisionTime.getTime() - 18 * 60_000),
    });

    expect(signal.pcr).toBeCloseTo(1.4, 10);
    expect(signal.pcrWindowed).toBe(signal.pcr);
    expect(signal.pcrScope).toBe("STRIKE_WINDOW_AROUND_SPOT");
    expect(signal.unavailableReason).toBeNull();
    expect(signal.ageMinutes).toBe(18);
  });

  it("surfaces STALE explicitly past the ceiling instead of a silent null", () => {
    const signal = buildOptionChainSignal({
      ...base, observedAt: new Date(decisionTime.getTime() - 25 * 60_000),
    });

    expect(signal.pcr).toBeNull();
    expect(signal.unavailableReason).toBe("STALE");
    expect(signal.unavailableMessage).toBe("PCR unavailable (stale)");
    expect(signal.ageMinutes).toBe(25);
    expect(signal.expiryDate).toBe("2026-09-22");
  });

  it("refuses a PCR when any contract in the book has missing open interest", () => {
    const signal = buildOptionChainSignal({
      ...base,
      putOpenInterest: 0,
      contractsWithMissingOpenInterest: 3,
      observedAt: new Date(decisionTime.getTime() - 60_000),
    });

    expect(signal.pcr).toBeNull();
    expect(signal.unavailableReason).toBe("INCOMPLETE_OPEN_INTEREST");
  });

  it("refuses a PCR with zero call OI and with an empty book", () => {
    const observedAt = new Date(decisionTime.getTime() - 60_000);
    expect(buildOptionChainSignal({ ...base, callOpenInterest: 0, observedAt }).unavailableReason)
      .toBe("NO_CALL_OPEN_INTEREST");
    expect(buildOptionChainSignal({ ...base, contracts: 0, observedAt }).unavailableReason)
      .toBe("NO_SNAPSHOT");
  });
});
