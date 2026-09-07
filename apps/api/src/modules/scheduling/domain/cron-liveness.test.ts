import { describe, expect, it } from "vitest";
import {
  assessCronStall,
  canaryCronExpression,
  canaryShouldBeFiring,
  canaryWindowOpenedAt,
} from "./cron-liveness.js";

/** IST instants, written as UTC because that is what the runtime sees. IST = UTC+5:30. */
const wednesday0930Ist = new Date("2026-09-02T04:00:00.000Z");
const wednesday1000Ist = new Date("2026-09-02T04:30:00.000Z");
const wednesday0800Ist = new Date("2026-09-02T02:30:00.000Z");
const wednesday1730Ist = new Date("2026-09-02T12:00:00.000Z");
const saturday1000Ist = new Date("2026-09-05T04:30:00.000Z");
const minutes = (n: number): number => n * 60_000;
const TOLERANCE = minutes(10);

describe("the canary window comes from the expression, not the market", () => {
  it("fires on weekdays through IST hours 9 to 15", () => {
    expect(canaryCronExpression).toBe("* 9-15 * * 1-5");
    expect(canaryShouldBeFiring(wednesday0930Ist)).toBe(true);
    // Hour 15 counts in full: `9-15` covers 15:00-15:59 whatever time the market shuts.
    expect(canaryShouldBeFiring(new Date("2026-09-02T10:15:00.000Z"))).toBe(true);
    expect(canaryShouldBeFiring(new Date("2026-09-02T10:35:00.000Z"))).toBe(false);
  });

  it("does not fire before the window or at the weekend", () => {
    expect(canaryShouldBeFiring(wednesday0800Ist)).toBe(false);
    expect(canaryShouldBeFiring(wednesday1730Ist)).toBe(false);
    expect(canaryShouldBeFiring(saturday1000Ist)).toBe(false);
  });

  it("opens at 09:00 IST on the current IST date", () => {
    // 09:00 IST = 03:30 UTC. Checked from an instant whose UTC date is the same, and from one
    // where the IST date is what matters.
    expect(canaryWindowOpenedAt(wednesday1000Ist).toISOString()).toBe("2026-09-02T03:30:00.000Z");
    expect(canaryWindowOpenedAt(new Date("2026-09-02T10:20:00.000Z")).toISOString())
      .toBe("2026-09-02T03:30:00.000Z");
  });
});

describe("it will not restart a healthy scheduler", () => {
  it("stays quiet outside the window, where silence is correct", () => {
    /*
     * Overnight the canary legitimately does not fire for ~17 hours. Acting on that would restart the
     * container every evening, and a restart loop is worse than the bug.
     */
    const verdict = assessCronStall({
      lastFiredAt: new Date("2026-09-01T10:29:00.000Z"),
      now: wednesday0800Ist,
      processStartedAt: new Date("2026-09-01T04:00:00.000Z"),
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toMatch(/outside the canary window/);
  });

  it("measures from the window open, not from process start", () => {
    /*
     * The trap that would have made this watchdog worse than nothing. A container started at 08:00
     * has been "silent" for 65 minutes by 09:05 -- because the canary cannot fire before 09:00.
     * Measuring from process start alone would kill every container five minutes into every session.
     */
    const verdict = assessCronStall({
      lastFiredAt: null,
      now: new Date("2026-09-02T03:35:00.000Z"), // 09:05 IST
      processStartedAt: wednesday0800Ist,
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(false);
    expect(verdict.silentForMs).toBe(minutes(5));
  });

  it("gives a freshly started container the full tolerance", () => {
    // Started mid-window, nothing fired yet. Legitimate for up to a minute; tolerated for ten.
    const verdict = assessCronStall({
      lastFiredAt: null,
      now: wednesday1000Ist,
      processStartedAt: new Date(wednesday1000Ist.getTime() - minutes(3)),
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(false);
  });

  it("is quiet while the canary keeps firing", () => {
    const verdict = assessCronStall({
      lastFiredAt: new Date(wednesday1000Ist.getTime() - minutes(1)),
      now: wednesday1000Ist,
      processStartedAt: wednesday0800Ist,
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toBe("the canary is firing");
  });

  it("does not fire exactly at the tolerance", () => {
    // Boundary pinned deliberately: the comparison is >, so ten minutes is tolerated and ten minutes
    // and one millisecond is not.
    const base = { lastFiredAt: null, processStartedAt: wednesday0800Ist, toleranceMs: TOLERANCE };
    const open = canaryWindowOpenedAt(wednesday1000Ist).getTime();

    expect(assessCronStall({ ...base, now: new Date(open + TOLERANCE) }).stalled).toBe(false);
    expect(assessCronStall({ ...base, now: new Date(open + TOLERANCE + 1) }).stalled).toBe(true);
  });
});

describe("it detects the failure it was built for", () => {
  it("catches a canary that never fired all session", () => {
    /*
     * 2026-08-28 exactly. The host resumed from Modern Standby at 09:01, the process stayed alive and
     * kept firing `*\/3 * * * *`, and no hour-restricted schedule ever fired again -- so `lastFiredAt`
     * is null through a whole trading day. Zero option premium ticks were written.
     */
    const verdict = assessCronStall({
      lastFiredAt: null,
      now: new Date("2026-09-02T06:00:00.000Z"), // 11:30 IST
      processStartedAt: new Date("2026-09-01T05:40:00.000Z"), // the day before
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toMatch(/has never fired/);
    expect(verdict.silentForMs).toBe(minutes(150)); // 09:00 -> 11:30 IST
  });

  it("catches a canary that fired and then stopped mid-session", () => {
    const verdict = assessCronStall({
      lastFiredAt: new Date("2026-09-02T04:00:00.000Z"), // 09:30 IST
      now: new Date("2026-09-02T04:45:00.000Z"), // 10:15 IST
      processStartedAt: wednesday0800Ist,
      toleranceMs: TOLERANCE,
    });

    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toMatch(/last fired 45 minutes ago/);
  });

  it("reports a reason even when healthy, so the log says what was concluded", () => {
    for (const now of [wednesday0800Ist, wednesday1000Ist]) {
      const verdict = assessCronStall({
        lastFiredAt: new Date(wednesday1000Ist.getTime() - minutes(1)),
        now,
        processStartedAt: wednesday0800Ist,
        toleranceMs: TOLERANCE,
      });
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses a non-positive tolerance instead of restarting on every check", () => {
    expect(() => assessCronStall({
      lastFiredAt: null, now: wednesday1000Ist, processStartedAt: wednesday0800Ist, toleranceMs: 0,
    })).toThrow(/tolerance must be positive/);
  });
});
