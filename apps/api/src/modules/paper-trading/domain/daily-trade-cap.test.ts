import { describe, expect, it } from "vitest";
import { decideDailyTradeCap, istTradingDayWindow } from "./daily-trade-cap.js";

describe("istTradingDayWindow", () => {
  it("spans one IST day as a half-open UTC range", () => {
    // 2026-08-17 09:16 IST = 03:46 UTC, inside the session.
    const window = istTradingDayWindow(new Date("2026-08-17T03:46:00Z"));

    expect(window.istDate).toBe("2026-08-17");
    expect(window.start.toISOString()).toBe("2026-08-16T18:30:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-17T18:30:00.000Z");
    expect(window.end.getTime() - window.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // The case a UTC date would get wrong. 20:00 UTC is already tomorrow in India, so a trade then
  // belongs to the next session's capacity, not to the day the UTC clock still shows.
  it("attributes a late-UTC instant to the IST date, not the UTC date", () => {
    const window = istTradingDayWindow(new Date("2026-08-17T20:00:00Z"));

    expect(window.istDate).toBe("2026-08-18");
  });

  it("puts a session close and the next session's open in different windows", () => {
    // 15:29 IST = 09:59 UTC; next morning 09:16 IST = 03:46 UTC.
    const close = istTradingDayWindow(new Date("2026-08-17T09:59:00Z"));
    const nextOpen = istTradingDayWindow(new Date("2026-08-18T03:46:00Z"));

    expect(close.istDate).toBe("2026-08-17");
    expect(nextOpen.istDate).toBe("2026-08-18");
    expect(close.end.getTime()).toBe(nextOpen.start.getTime());
  });

  it("keeps a whole session inside one window", () => {
    // 09:15 and 15:30 IST on the same day.
    const open = istTradingDayWindow(new Date("2026-08-17T03:45:00Z"));
    const close = istTradingDayWindow(new Date("2026-08-17T10:00:00Z"));

    expect(open.istDate).toBe(close.istDate);
    expect(open.start.getTime()).toBe(close.start.getTime());
  });

  it("treats the boundary instant as belonging to the later day", () => {
    // Exactly 00:00 IST. Half-open means `start` is inclusive, so this opens the new day.
    const window = istTradingDayWindow(new Date("2026-08-16T18:30:00.000Z"));

    expect(window.istDate).toBe("2026-08-17");
    expect(window.start.toISOString()).toBe("2026-08-16T18:30:00.000Z");
  });

  it("refuses an invalid instant", () => {
    expect(() => istTradingDayWindow(new Date("nonsense"))).toThrow(/valid instant/);
  });
});

describe("decideDailyTradeCap", () => {
  it("allows anything when no cap is configured", () => {
    expect(decideDailyTradeCap({ openedToday: 9_999, cap: null }))
      .toMatchObject({ allowed: true, reason: "NO_CAP" });
  });

  it("allows an open below the cap", () => {
    expect(decideDailyTradeCap({ openedToday: 20, cap: 60 }))
      .toMatchObject({ allowed: true, reason: "WITHIN_CAP", openedToday: 20, cap: 60 });
  });

  // The boundary that decides whether a cap of n permits n or n+1 trades. Reaching the cap blocks
  // the next open, so a cap of 60 permits exactly 60 trades.
  it("blocks once the count has reached the cap", () => {
    expect(decideDailyTradeCap({ openedToday: 59, cap: 60 })).toMatchObject({ allowed: true });
    expect(decideDailyTradeCap({ openedToday: 60, cap: 60 }))
      .toMatchObject({ allowed: false, reason: "DAILY_TRADE_CAP_REACHED", openedToday: 60, cap: 60 });
  });

  it("blocks when the count is somehow past the cap", () => {
    // Reachable if a cap is lowered mid-day; the gate must not read that as capacity.
    expect(decideDailyTradeCap({ openedToday: 75, cap: 60 })).toMatchObject({ allowed: false });
  });

  // Zero is a real setting that stops trading, and must not be confused with "no cap".
  it("distinguishes a cap of zero from no cap", () => {
    expect(decideDailyTradeCap({ openedToday: 0, cap: 0 }))
      .toMatchObject({ allowed: false, reason: "DAILY_TRADE_CAP_REACHED" });
    expect(decideDailyTradeCap({ openedToday: 0, cap: null }))
      .toMatchObject({ allowed: true, reason: "NO_CAP" });
  });

  it.each([[-1], [1.5]])("refuses a nonsensical cap of %s", (cap) => {
    expect(() => decideDailyTradeCap({ openedToday: 0, cap })).toThrow(/non-negative integer/);
  });

  it("refuses a nonsensical count", () => {
    expect(() => decideDailyTradeCap({ openedToday: -1, cap: 10 })).toThrow(/non-negative integer/);
  });
});
