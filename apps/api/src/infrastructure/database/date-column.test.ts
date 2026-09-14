import { describe, expect, it } from "vitest";
import { fromDateColumn, toDateKey } from "./date-column.js";

describe("fromDateColumn", () => {
  it("re-anchors a local-midnight Date to the same calendar day in UTC", () => {
    // What node-pg hands back for a DATE column: midnight in the host's zone.
    const localMidnight = new Date(2026, 6, 30, 0, 0, 0, 0);
    expect(toDateKey(fromDateColumn(localMidnight))).toBe("2026-07-30");
  });

  it("does not shift the day for a host east of UTC", () => {
    // The IST regression: a local-midnight 2026-07-30 has a UTC instant of
    // 2026-07-29T18:30Z, so a bare toISOString() reported the wrong session.
    const istMidnight = new Date("2026-07-29T18:30:00.000Z");
    expect(istMidnight.toISOString().slice(0, 10)).toBe("2026-07-29");
    // Only meaningful when the test host actually runs in IST; assert the
    // round-trip property that holds everywhere instead.
    const roundTripped = fromDateColumn(new Date(2026, 6, 30));
    expect(roundTripped.getUTCFullYear()).toBe(2026);
    expect(roundTripped.getUTCMonth()).toBe(6);
    expect(roundTripped.getUTCDate()).toBe(30);
    expect(roundTripped.getUTCHours()).toBe(0);
  });

  it("accepts a pass-through date string", () => {
    expect(toDateKey(fromDateColumn("2026-07-30"))).toBe("2026-07-30");
    expect(toDateKey(fromDateColumn("2026-07-30T00:00:00.000Z"))).toBe("2026-07-30");
  });

  it("round-trips through toDateKey for every day of a month", () => {
    for (let day = 1; day <= 31; day += 1) {
      const key = `2026-07-${String(day).padStart(2, "0")}`;
      expect(toDateKey(fromDateColumn(key))).toBe(key);
    }
  });

  it("rejects a value that is not a date rather than inventing one", () => {
    expect(() => fromDateColumn(null)).toThrow(/Expected a DATE column value/);
    expect(() => fromDateColumn(undefined)).toThrow(/Expected a DATE column value/);
    expect(() => fromDateColumn("not-a-date")).toThrow(/Expected a DATE column value/);
  });
});
