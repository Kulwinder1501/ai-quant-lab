import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canaryCronExpression } from "../../modules/scheduling/domain/cron-liveness.js";

/**
 * Every cron registration must go through `cronSchedule`, or the stall watchdog is blind to it.
 *
 * A source-level guard because the failure is silent and expensive. On 2026-08-28 the host resumed
 * from Modern Standby and the hour-restricted timers never re-armed; the process stayed alive, one
 * job type of twenty-two kept claiming, and a full trading session was lost with zero
 * `option_premium_ticks`. The watchdog that now catches it can only see fires it is told about.
 *
 * The risk this guards is ordinary and likely: someone adds a job, copies the `cron.schedule(...)`
 * shape from git history or from another file, and the new schedule silently sits outside the
 * watchdog's view. A reviewer would have to notice one line among a thousand.
 */

const SCHEDULER = resolve(process.cwd(), "src", "interfaces", "scheduler", "scheduler.ts");

function source(): string {
  return readFileSync(SCHEDULER, "utf8");
}

/** Strips comments, so prose about `cron.schedule` does not read as a call. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1 ");
}

describe("the scheduler's cron registrations", () => {
  it("calls cron.schedule exactly once, inside the wrapper", () => {
    /*
     * One occurrence: the wrapper's own delegation. Any second call is a registration the watchdog
     * cannot see. The assertion is on the count rather than on a pattern match because the bypass
     * looks completely normal at the call site.
     */
    const code = codeOnly(source());

    expect(code.match(/\bcron\.schedule\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/function cronSchedule\(/);
    // The single call must be the one that stamps the fire timestamp.
    expect(code).toMatch(/cron\.schedule\(expression, \(\) => \{\s*cronLastFiredAt\.set\(/);
  });

  it("registers the canary the watchdog depends on", () => {
    // The scheduler also asserts this at startup; checked here so the failure surfaces in CI rather
    // than in a container that then refuses to boot.
    expect(codeOnly(source())).toContain(`cronSchedule("${canaryCronExpression}"`);
  });

  it("applies the timezone in one place", () => {
    /*
     * Every registration used to repeat `{ timezone: IST }`. Centralising it removes the chance of a
     * new cron omitting it -- which would silently schedule in UTC and shift a market-hours job by
     * five and a half hours.
     */
    const code = codeOnly(source());

    expect(code.match(/timezone: IST/g) ?? []).toHaveLength(2); // the wrapper, and the startup log
  });

  it("stamps the timestamp before running the handler", () => {
    /*
     * Order matters: a handler that throws still proves the timer fired. Stamping afterwards would
     * let a persistently throwing job read as a dead timer and restart the container in a loop,
     * which is worse than the stall it is meant to fix.
     */
    const code = codeOnly(source());
    const stamp = code.indexOf("cronLastFiredAt.set(expression, new Date())");
    const handler = code.indexOf("handler();");

    expect(stamp).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(stamp);
  });

  it("exits rather than only logging when the timers stall", () => {
    // The whole point of the change. A log line cannot re-arm a timer.
    const code = codeOnly(source());

    expect(code).toMatch(/shutdown\("CRON_STALL", CRON_STALL_EXIT_CODE\)/);
    expect(code).toMatch(/CRON_STALL_EXIT_CODE = 75/);
  });
});
