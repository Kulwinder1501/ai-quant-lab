import { describe, expect, it } from "vitest";
import { GOLD_CATCH_UP_AFTER_OPEN_MINUTES, GOLD_CATCH_UP_COOLDOWN_MINUTES, goldCatchUpCooldownElapsed, goldCatchUpDue, openMinutesBetween } from "./gold-catch-up.js";

const at = (iso: string): Date => new Date(iso);
const minutesBefore = (instant: Date, minutes: number): Date => new Date(instant.getTime() - minutes * 60_000);
const always = (): boolean => true;

describe("openMinutesBetween", () => {
  it("counts the minutes between two instants when the market is always open", () => {
    expect(openMinutesBetween(at("2026-01-13T14:00:00Z"), at("2026-01-13T14:30:00Z"), 1000, always)).toBe(30);
  });

  it("stops at the cap, so a long stretch is cheap", () => {
    expect(openMinutesBetween(at("2026-01-13T14:00:00Z"), at("2026-01-14T14:00:00Z"), 50, always)).toBe(50);
  });

  it("counts nothing for the weekend close and only the open minutes of gold's own calendar", () => {
    // Friday 22:00Z (17:00 New York) to Sunday 23:30Z: only the 30 minutes after Sunday's 23:00Z reopen count
    expect(openMinutesBetween(at("2026-01-09T22:00:00Z"), at("2026-01-11T23:30:00Z"), 1000)).toBe(30);
  });
});

describe("goldCatchUpCooldownElapsed", () => {
  const now = at("2026-01-13T14:00:00Z");

  it("allows the first attempt of a process", () => {
    expect(goldCatchUpCooldownElapsed(null, now)).toBe(true);
  });

  it("refuses a second attempt inside an hour and allows it at an hour, so a closure the calendar does not know cannot repeat the heal every tick", () => {
    expect(GOLD_CATCH_UP_COOLDOWN_MINUTES).toBe(60);
    expect(goldCatchUpCooldownElapsed(minutesBefore(now, 5), now)).toBe(false);
    expect(goldCatchUpCooldownElapsed(minutesBefore(now, 59), now)).toBe(false);
    expect(goldCatchUpCooldownElapsed(minutesBefore(now, 60), now)).toBe(true);
  });
});

describe("goldCatchUpDue", () => {
  const now = at("2026-01-13T14:00:00Z"); // Tuesday, 09:00 New York, open

  it("is not due on an ordinary tick, with the newest bar a few minutes old", () => {
    expect(goldCatchUpDue({ newestBarCloseTime: minutesBefore(now, 5), now })).toBe(false);
  });

  it("is due once fifty open minutes have passed with no new bar, and not a minute before", () => {
    expect(GOLD_CATCH_UP_AFTER_OPEN_MINUTES).toBe(50);
    expect(goldCatchUpDue({ newestBarCloseTime: minutesBefore(now, 49), now })).toBe(false);
    expect(goldCatchUpDue({ newestBarCloseTime: minutesBefore(now, 50), now })).toBe(true);
  });

  it("is due on the morning after the host slept: the newest bar is from the previous afternoon", () => {
    // newest bar closed 15:30Z the day before, the scheduler is back at 03:00Z
    expect(goldCatchUpDue({ newestBarCloseTime: at("2026-01-12T15:30:00Z"), now: at("2026-01-13T03:00:00Z") })).toBe(true);
  });

  it("does not count the daily New York break, which is not missing data", () => {
    // newest bar closed 21:30Z; at 23:10Z (18:10 New York) only 30 minutes before the break and 10 after it were open: 40
    expect(goldCatchUpDue({ newestBarCloseTime: at("2026-01-12T21:30:00Z"), now: at("2026-01-12T23:10:00Z") })).toBe(false);
    // by 23:25Z that is 55 open minutes with no bar
    expect(goldCatchUpDue({ newestBarCloseTime: at("2026-01-12T21:30:00Z"), now: at("2026-01-12T23:25:00Z") })).toBe(true);
  });

  it("does not fire at the weekend reopen just because Friday's last bar is old", () => {
    const fridayClose = at("2026-01-09T22:00:00Z");
    expect(goldCatchUpDue({ newestBarCloseTime: fridayClose, now: at("2026-01-11T23:30:00Z") })).toBe(false);
    // but a scheduler that is not collecting once it has reopened is behind, like any other time
    expect(goldCatchUpDue({ newestBarCloseTime: fridayClose, now: at("2026-01-11T23:55:00Z") })).toBe(true);
  });

  it("with no bar stored at all, is due only while the market is open", () => {
    expect(goldCatchUpDue({ newestBarCloseTime: null, now })).toBe(true);
    expect(goldCatchUpDue({ newestBarCloseTime: null, now: at("2026-01-10T12:00:00Z") })).toBe(false); // Saturday
  });
});
