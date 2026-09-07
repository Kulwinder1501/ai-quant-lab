import { describe, expect, it } from "vitest";
import { calculateNseMarketElapsedMs, formatNseMarketElapsedDuration } from "./nse-market-time";

describe("NSE market elapsed time", () => {
  it("counts only the overlap with an open session", () => {
    const opened = "2026-08-03T03:45:00.000Z"; // Monday 09:15 IST
    const now = new Date("2026-08-03T04:45:00.000Z").getTime(); // 10:15 IST
    expect(calculateNseMarketElapsedMs(opened, now)).toBe(60 * 60_000);
    expect(formatNseMarketElapsedDuration(opened, now)).toBe("1h 0m 0s");
  });

  it("starts a Sunday-opened position clock at Monday market open", () => {
    const opened = "2026-08-02T15:02:26.030Z"; // Sunday 20:32 IST
    const now = new Date("2026-08-03T04:45:00.000Z").getTime();
    expect(formatNseMarketElapsedDuration(opened, now)).toBe("1h 0m 0s");
  });

  it("freezes after close and overnight", () => {
    const opened = "2026-08-03T03:45:00.000Z";
    const nextMorning = new Date("2026-08-04T03:30:00.000Z").getTime(); // 09:00 IST
    expect(formatNseMarketElapsedDuration(opened, nextMorning)).toBe("1d 0h 0m");
  });

  it("skips weekends while accumulating partial Friday and Monday sessions", () => {
    const opened = "2026-08-07T09:00:00.000Z"; // Friday 14:30 IST
    const monday = new Date("2026-08-10T04:45:00.000Z").getTime(); // Monday 10:15 IST
    expect(formatNseMarketElapsedDuration(opened, monday)).toBe("2h 0m 0s");
  });

  it("supports explicit NSE holiday exclusions", () => {
    const opened = "2026-08-03T03:45:00.000Z";
    const tuesday = new Date("2026-08-04T04:45:00.000Z").getTime();
    expect(calculateNseMarketElapsedMs(opened, tuesday, ["2026-08-03"])).toBe(60 * 60_000);
  });

  it("returns an unavailable marker for invalid or future timestamps", () => {
    const now = new Date("2026-08-03T04:45:00.000Z").getTime();
    expect(formatNseMarketElapsedDuration("invalid", now)).toBe("—");
    expect(formatNseMarketElapsedDuration("2026-08-04T03:45:00.000Z", now)).toBe("—");
  });
});
