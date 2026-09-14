/**
 * Detects the scheduler's own cron timers having stopped firing, which `findOverdueScheduledJobs`
 * structurally cannot.
 *
 * ## The failure this exists for
 *
 * Measured 2026-08-28. The host entered Windows Modern Standby overnight, which suspends the Docker
 * VM; on resume the scheduler kept running but only its frequent, hour-unrestricted cron
 * (`*\/3 * * * *`, RSS news) fired again. Every `9-15 * * 1-5` schedule stayed dead for the whole
 * trading day:
 *
 * | day | claims | job types |
 * | :--- | ---: | ---: |
 * | 08-27 (from 11:10) | 1,440 | 22 |
 * | **08-28** | **187** | **1** |
 * | 08-31 | 640 | 17 |
 *
 * `claimed_by` was the same process across all three days -- no restart, no crash, no failure row.
 * The cost was a full session with zero `option_premium_ticks`, and index candles looked perfect
 * throughout because they come from a different container.
 *
 * ## Why the existing liveness check could not catch it
 *
 * `findOverdueScheduledJobs` shipped after the previous stall and would have detected this one, but it
 * is registered on `cron.schedule("*\/5 9-15 * * 1-5", …)` **inside the same process** -- so it dies of
 * the condition it detects. Its only output is a log line, and container logs are gone the moment the
 * container is recreated. A watchdog that shares its subject's failure mode and writes only to a log
 * is not a watchdog.
 *
 * So this module is deliberately different in three ways: it is driven by a plain interval rather than
 * a cron, every decision is made from the wall clock rather than from timer accuracy, and its
 * conclusion is an exit code rather than a message.
 *
 * ## It measures firing, not completing
 *
 * The distinction is the whole point. A job that fires and fails writes a FAILED row and is a
 * different problem -- restarting the process would not fix it and might mask it. This watches whether
 * the cron callback ran at all, so a stalled timer and a broken job can never be confused.
 *
 * That is also why holidays need no consideration here: `node-cron` fires on holidays too, and the
 * jobs skip internally. The window below is a property of the cron expression, never of the market.
 */

/** India has no DST, so a fixed offset is exact. Same constant the session module uses. */
const istOffsetMs = 5.5 * 60 * 60_000;

/**
 * The canary: the densest hour-restricted schedule in the scheduler.
 *
 * `* 9-15 * * 1-5` fires **every minute** of every weekday hour from 09:00 to 15:59 IST, which makes
 * a ten-minute silence inside that window unambiguous. Watching one crisp invariant beats parsing
 * every registered expression to work out which ought to have fired by now.
 *
 * The scheduler asserts at startup that this expression is actually registered. Without that, editing
 * or removing that cron would leave the watchdog silently watching nothing -- which is precisely the
 * class of failure it exists to prevent.
 */
export const canaryCronExpression = "* 9-15 * * 1-5";

function istParts(instant: Date): { readonly weekday: number; readonly hour: number } {
  const shifted = new Date(instant.getTime() + istOffsetMs);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/**
 * Whether the canary is expected to be firing right now.
 *
 * Read straight off the expression: weekday Monday-Friday, IST hour within 9-15 inclusive. Hour 15
 * counts in full, because `9-15` covers 15:00-15:59 regardless of when the market shuts.
 */
export function canaryShouldBeFiring(now: Date): boolean {
  const { weekday, hour } = istParts(now);
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour <= 15;
}

/** The instant the current firing window opened: 09:00 IST on `now`'s IST date. */
export function canaryWindowOpenedAt(now: Date): Date {
  const shifted = new Date(now.getTime() + istOffsetMs);
  shifted.setUTCHours(9, 0, 0, 0);
  return new Date(shifted.getTime() - istOffsetMs);
}

export interface CronStallVerdict {
  readonly stalled: boolean;
  /** Always populated, including when healthy: the log line has to say what was concluded and why. */
  readonly reason: string;
  readonly silentForMs: number | null;
}

/**
 * Whether the cron timers have provably stalled.
 *
 * ## The baseline is the latest of three instants, and each one prevents a false positive
 *
 * Silence is measured from whichever came last: the canary's last fire, the process start, or the
 * window opening. Miss any of them and the watchdog kills a healthy process:
 *
 * - **last fire** -- the obvious one, and the only one that is null on a total stall.
 * - **process start** -- a container that has just come up has not had a minute to fire yet.
 * - **window open** -- the trap. A process started at 08:00 has been silent for 65 minutes by 09:05,
 *   because the canary cannot fire before 09:00. Measuring from process start alone would restart
 *   every container five minutes into every session.
 *
 * A null `lastFiredAt` is therefore not special-cased: on 08-28 the canary never fired at all, and
 * measuring from the window open detects exactly that.
 */
export function assessCronStall(input: {
  readonly lastFiredAt: Date | null;
  readonly now: Date;
  readonly processStartedAt: Date;
  readonly toleranceMs: number;
}): CronStallVerdict {
  if (input.toleranceMs <= 0) {
    throw new Error("A cron stall tolerance must be positive; zero would restart on every check.");
  }
  if (!canaryShouldBeFiring(input.now)) {
    return {
      stalled: false,
      reason: "outside the canary window; the schedule is not expected to fire",
      silentForMs: null,
    };
  }

  const baseline = Math.max(
    input.lastFiredAt?.getTime() ?? 0,
    input.processStartedAt.getTime(),
    canaryWindowOpenedAt(input.now).getTime(),
  );
  const silentForMs = input.now.getTime() - baseline;
  if (silentForMs <= input.toleranceMs) {
    return { stalled: false, reason: "the canary is firing", silentForMs };
  }

  return {
    stalled: true,
    reason: input.lastFiredAt === null
      ? `the canary "${canaryCronExpression}" has never fired, and the window opened `
        + `${Math.round(silentForMs / 60_000)} minutes ago`
      : `the canary "${canaryCronExpression}" last fired ${Math.round(silentForMs / 60_000)} minutes `
        + "ago inside its own window",
    silentForMs,
  };
}
