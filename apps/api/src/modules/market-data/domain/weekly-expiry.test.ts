import { describe, expect, it } from "vitest";
import { resolveWeeklyExpiryWeekday } from "./weekly-expiry.js";

describe("resolveWeeklyExpiryWeekday", () => {
  it("allows a confirmed weekday", () => {
    expect(resolveWeeklyExpiryWeekday({ weekday: 4, source: "CONFIRMED" }, "NIFTY50"))
      .toEqual({ usable: true, weekday: 4 });
  });

  it("refuses an assumed weekday, however plausible", () => {
    // The seeded NIFTY50 Thursday. Probably right -- but "probably" is not a basis for
    // pricing, because a wrong expiry produces correct-looking premium and greeks.
    const resolution = resolveWeeklyExpiryWeekday({ weekday: 4, source: "ASSUMED" }, "NIFTY50");

    expect(resolution.usable).toBe(false);
    expect(resolution).toMatchObject({ reason: "UNCONFIRMED_WEEKDAY" });
    expect(resolution.usable === false && resolution.explanation).toContain("CONFIRMED");
  });

  it("refuses an unset weekday, which is how a monthly-only index is recorded", () => {
    const resolution = resolveWeeklyExpiryWeekday({ weekday: null, source: null }, "BANKNIFTY");

    expect(resolution).toMatchObject({ usable: false, reason: "NO_WEEKLY_SERIES" });
  });

  it("refuses a half-populated specification rather than guessing which half to trust", () => {
    expect(resolveWeeklyExpiryWeekday({ weekday: 3, source: null }, "BANKNIFTY").usable).toBe(false);
    expect(resolveWeeklyExpiryWeekday({ weekday: null, source: "CONFIRMED" }, "BANKNIFTY").usable).toBe(false);
  });

  it("names the instrument, so the message is actionable where it surfaces", () => {
    const resolution = resolveWeeklyExpiryWeekday({ weekday: 3, source: "ASSUMED" }, "BANKNIFTY");

    expect(resolution.usable === false && resolution.explanation).toContain("BANKNIFTY");
    expect(resolution.usable === false && resolution.explanation).toContain("3");
  });
});
