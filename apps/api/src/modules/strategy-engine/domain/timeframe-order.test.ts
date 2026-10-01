import { describe, expect, it } from "vitest";

import { isStrictlyHigherTimeframe, timeframeMilliseconds } from "./timeframe-order.js";

describe("timeframeMilliseconds", () => {
  it("parses the minute, hour and day units", () => {
    expect(timeframeMilliseconds("1m")).toBe(60_000);
    expect(timeframeMilliseconds("15m")).toBe(900_000);
    expect(timeframeMilliseconds("1h")).toBe(3_600_000);
    expect(timeframeMilliseconds("1d")).toBe(86_400_000);
  });

  it("returns null for a label it cannot place", () => {
    expect(timeframeMilliseconds("weekly")).toBeNull();
    expect(timeframeMilliseconds("0m")).toBeNull();
    expect(timeframeMilliseconds("")).toBeNull();
  });
});

describe("isStrictlyHigherTimeframe", () => {
  it("orders by duration, not lexically", () => {
    // The case that motivates the module: "15m" < "5m" as strings, so a lexical compare would
    // treat 5m as higher than 15m and let a 15m signal take a faster bar as its confluence.
    expect(isStrictlyHigherTimeframe("1m", "15m")).toBe(true);
    expect(isStrictlyHigherTimeframe("15m", "5m")).toBe(false);
    expect(isStrictlyHigherTimeframe("5m", "15m")).toBe(true);
  });

  it("refuses an equal timeframe, which is the same bar rather than confluence", () => {
    expect(isStrictlyHigherTimeframe("5m", "5m")).toBe(false);
  });

  it("refuses an unparseable label instead of throwing", () => {
    expect(isStrictlyHigherTimeframe("1m", "weekly")).toBe(false);
    expect(isStrictlyHigherTimeframe("weekly", "1m")).toBe(false);
  });
});
