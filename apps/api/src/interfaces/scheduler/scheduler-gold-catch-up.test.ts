import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The wake catch-up is wired into the scheduler, whose module cannot be imported without starting its real cron jobs, so the
 * wiring is checked against the source text (the same way `scheduler-npm-scripts.test.ts` does). What the decision is, and how it
 * behaves on real receipt times, is tested in `gold-catch-up.test.ts`; this pins the two things only the wiring decides.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scheduler.ts"), "utf8");

describe("the gold wake catch-up in the scheduler", () => {
  it("runs before the tick's own collection, in the same sequenced block", () => {
    const tick = source.slice(source.indexOf("const xauCollectionTick"));
    expect(tick.indexOf('schedule("XAU_WAKE_CATCHUP"')).toBeGreaterThan(-1);
    expect(tick.indexOf('schedule("XAU_WAKE_CATCHUP"')).toBeLessThan(tick.indexOf('schedule("XAU_CANDLE_COLLECTION"'));
  });

  it("runs the heal only when due and past the cooldown, and notes the attempt before it starts so a failed or endless heal is not retried every tick", () => {
    const hook = source.slice(source.indexOf("const catchUpGoldIfBehind"), source.indexOf("const xauCollectionTick"));
    const due = hook.indexOf("goldCatchUpDue(");
    const cooldown = hook.indexOf("goldCatchUpCooldownElapsed(lastGoldCatchUpAttemptAt");
    const noted = hook.indexOf("lastGoldCatchUpAttemptAt = now");
    const heal = hook.indexOf('"data:heal-gold-gaps"');

    expect(due).toBeGreaterThan(-1);
    expect(cooldown).toBeGreaterThan(due);
    expect(noted).toBeGreaterThan(cooldown);
    expect(heal).toBeGreaterThan(noted);
  });

  it("has a timeout and is listed in the gold job inventory", () => {
    expect(source).toContain("XAU_WAKE_CATCHUP: 10 * 60 * 1000");
    expect(source).toContain('"XAU_CANDLE_COLLECTION", "XAU_WAKE_CATCHUP"');
  });
});
