import { describe, expect, it } from "vitest";
import { isNearXauWeeklyClose, isXauSessionOpen } from "./continuous-weekly-session.js";

describe("isXauSessionOpen", () => {
  it("is closed all of Saturday", () => {
    expect(isXauSessionOpen(new Date("2026-09-19T00:00:00.000Z"))).toBe(false);
    expect(isXauSessionOpen(new Date("2026-09-19T12:00:00.000Z"))).toBe(false);
    expect(isXauSessionOpen(new Date("2026-09-19T23:59:00.000Z"))).toBe(false);
  });

  it("is closed on Sunday before 22:00 UTC and open from 22:00 UTC", () => {
    expect(isXauSessionOpen(new Date("2026-09-20T00:00:00.000Z"))).toBe(false);
    expect(isXauSessionOpen(new Date("2026-09-20T21:59:00.000Z"))).toBe(false);
    expect(isXauSessionOpen(new Date("2026-09-20T22:00:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-20T23:00:00.000Z"))).toBe(true);
  });

  it("is open all of Monday through Thursday", () => {
    expect(isXauSessionOpen(new Date("2026-09-21T00:00:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-22T12:00:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-23T23:59:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-24T06:00:00.000Z"))).toBe(true);
  });

  it("is open on Friday before 22:00 UTC and closed from 22:00 UTC", () => {
    expect(isXauSessionOpen(new Date("2026-09-25T00:00:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-25T21:59:00.000Z"))).toBe(true);
    expect(isXauSessionOpen(new Date("2026-09-25T22:00:00.000Z"))).toBe(false);
    expect(isXauSessionOpen(new Date("2026-09-25T23:00:00.000Z"))).toBe(false);
  });
});

describe("isNearXauWeeklyClose", () => {
  it("is false outside the trailing window before Friday close", () => {
    expect(isNearXauWeeklyClose(new Date("2026-09-25T21:00:00.000Z"), 30)).toBe(false);
    expect(isNearXauWeeklyClose(new Date("2026-09-24T21:45:00.000Z"), 30)).toBe(false); // Thursday
  });

  it("is true inside the trailing window before Friday close", () => {
    expect(isNearXauWeeklyClose(new Date("2026-09-25T21:30:00.000Z"), 30)).toBe(true);
    expect(isNearXauWeeklyClose(new Date("2026-09-25T21:59:00.000Z"), 30)).toBe(true);
  });

  it("is false at and after the close itself", () => {
    expect(isNearXauWeeklyClose(new Date("2026-09-25T22:00:00.000Z"), 30)).toBe(false);
  });
});
