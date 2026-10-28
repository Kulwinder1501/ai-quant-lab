import { afterEach, describe, expect, it, vi } from "vitest";
import { isSideSplitWatchWindow, sideSplitSymbols, startLiveSideSplitFeed } from "./live-side-split-feed.js";

const at = (iso: string): Date => new Date(iso);

describe("sideSplitSymbols", () => {
  it("is the front month of each index on the day, and the next month once the expiry has passed", () => {
    // 2026-10-27 is the October expiry itself: still the front month for the day.
    expect(sideSplitSymbols(at("2026-10-27T04:30:00Z"))).toEqual(["NSE:NIFTY26OCTFUT", "NSE:BANKNIFTY26OCTFUT"]);
    expect(sideSplitSymbols(at("2026-10-28T04:30:00Z"))).toEqual(["NSE:NIFTY26NOVFUT", "NSE:BANKNIFTY26NOVFUT"]);
  });
});

describe("isSideSplitWatchWindow", () => {
  it("is a weekday from 09:00 up to 15:35 IST", () => {
    expect(isSideSplitWatchWindow(at("2026-10-27T03:29:00Z"))).toBe(false); // 08:59 IST Tue
    expect(isSideSplitWatchWindow(at("2026-10-27T03:30:00Z"))).toBe(true); // 09:00
    expect(isSideSplitWatchWindow(at("2026-10-27T10:04:00Z"))).toBe(true); // 15:34
    expect(isSideSplitWatchWindow(at("2026-10-27T10:05:00Z"))).toBe(false); // 15:35
  });

  it("is closed all weekend", () => {
    expect(isSideSplitWatchWindow(at("2026-10-24T05:00:00Z"))).toBe(false); // Saturday
    expect(isSideSplitWatchWindow(at("2026-10-25T05:00:00Z"))).toBe(false); // Sunday
  });
});

describe("startLiveSideSplitFeed", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("subscribes the front months at once in the window, again each minute, and stops when told", () => {
    vi.useFakeTimers();
    const subscribe = vi.fn();
    const stop = startLiveSideSplitFeed({ streamer: { subscribe }, now: () => at("2026-10-27T04:30:00Z") });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(["NSE:NIFTY26OCTFUT", "NSE:BANKNIFTY26OCTFUT"]);
    vi.advanceTimersByTime(60_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(180_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("asks for nothing outside the window, so a night-time API opens no socket for this", () => {
    vi.useFakeTimers();
    const subscribe = vi.fn();
    const stop = startLiveSideSplitFeed({ streamer: { subscribe }, now: () => at("2026-10-27T18:00:00Z") });
    vi.advanceTimersByTime(300_000);
    expect(subscribe).not.toHaveBeenCalled();
    stop();
  });
});
