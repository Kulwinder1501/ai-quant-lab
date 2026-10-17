import { describe, expect, it } from "vitest";
import { istMinuteOfHour, shouldFetchIndexHistory } from "./index-history-cadence.js";

describe("shouldFetchIndexHistory", () => {
  it("always fetches 1m", () => {
    for (let minute = 0; minute < 60; minute += 1) expect(shouldFetchIndexHistory("1m", minute)).toBe(true);
  });

  it("fetches 5m on the close minute and the retry after it only", () => {
    const fetched = Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => shouldFetchIndexHistory("5m", minute));
    expect(fetched).toEqual([0, 1, 5, 6, 10, 11, 15, 16, 20, 21, 25, 26, 30, 31, 35, 36, 40, 41, 45, 46, 50, 51, 55, 56]);
  });

  it("fetches 15m on the close minute and the retry after it only", () => {
    const fetched = Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => shouldFetchIndexHistory("15m", minute));
    expect(fetched).toEqual([0, 1, 15, 16, 30, 31, 45, 46]);
  });

  it("keeps fetching a timeframe it does not know", () => {
    expect(shouldFetchIndexHistory("30m", 7)).toBe(true);
  });

  it("cuts the per-minute history calls for both indices from six to about three", () => {
    let calls = 0;
    for (let minute = 0; minute < 60; minute += 1) {
      for (const timeframe of ["1m", "5m", "15m"]) if (shouldFetchIndexHistory(timeframe, minute)) calls += 2;
    }
    expect(calls).toBe(60 * 2 + 24 * 2 + 8 * 2);
    expect(calls / 60).toBeLessThan(3.5);
  });
});

describe("istMinuteOfHour", () => {
  it("reads the IST minute, which is the UTC minute shifted by thirty", () => {
    expect(istMinuteOfHour(new Date("2026-10-19T03:45:00Z"))).toBe(15);
    expect(istMinuteOfHour(new Date("2026-10-19T03:50:30Z"))).toBe(20);
    expect(istMinuteOfHour(new Date("2026-10-19T04:00:00Z"))).toBe(30);
  });
});
