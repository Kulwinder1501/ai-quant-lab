import { afterEach, describe, expect, it, vi } from "vitest";
import { isSilentSymbolCheckWindow, startFyersStreamerWatchdog } from "./fyers-streamer-watchdog.js";

const at = (iso: string): Date => new Date(iso);
const NONE = { action: "NONE" as const, reason: "", silent: [] };

describe("isSilentSymbolCheckWindow", () => {
  it("is a weekday from 09:20 up to 15:25 IST, after the open settles and before the close thins the feed", () => {
    expect(isSilentSymbolCheckWindow(at("2026-10-27T03:49:00Z"))).toBe(false); // 09:19 IST Tue
    expect(isSilentSymbolCheckWindow(at("2026-10-27T03:50:00Z"))).toBe(true); // 09:20
    expect(isSilentSymbolCheckWindow(at("2026-10-27T09:54:00Z"))).toBe(true); // 15:24
    expect(isSilentSymbolCheckWindow(at("2026-10-27T09:55:00Z"))).toBe(false); // 15:25
  });

  it("is closed all weekend", () => {
    expect(isSilentSymbolCheckWindow(at("2026-10-24T05:00:00Z"))).toBe(false); // Saturday
    expect(isSilentSymbolCheckWindow(at("2026-10-25T05:00:00Z"))).toBe(false); // Sunday
  });
});

describe("startFyersStreamerWatchdog", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("checks every fifteen seconds in the window, and stops when told", () => {
    vi.useFakeTimers();
    const checkForSilentSymbols = vi.fn(() => NONE);
    const stop = startFyersStreamerWatchdog({ streamer: { checkForSilentSymbols }, now: () => at("2026-10-27T05:00:00Z") });
    expect(checkForSilentSymbols).not.toHaveBeenCalled(); // not at once: the first check is a timer away
    vi.advanceTimersByTime(15_000);
    expect(checkForSilentSymbols).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(checkForSilentSymbols).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(checkForSilentSymbols).toHaveBeenCalledTimes(3);
  });

  it("does not check outside the session, so pre-open options that send nothing are not mistaken for a failed subscription", () => {
    vi.useFakeTimers();
    const checkForSilentSymbols = vi.fn(() => NONE);
    startFyersStreamerWatchdog({ streamer: { checkForSilentSymbols }, now: () => at("2026-10-27T03:35:00Z") }); // 09:05 IST
    vi.advanceTimersByTime(120_000);
    expect(checkForSilentSymbols).not.toHaveBeenCalled();
  });

  it("reports a check that throws and keeps checking", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const checkForSilentSymbols = vi.fn(() => { throw new Error("boom"); });
    startFyersStreamerWatchdog({ streamer: { checkForSilentSymbols }, now: () => at("2026-10-27T05:00:00Z"), report });
    vi.advanceTimersByTime(30_000);
    expect(checkForSilentSymbols).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith("The silent-symbol check failed", { error: "boom" });
  });
});
