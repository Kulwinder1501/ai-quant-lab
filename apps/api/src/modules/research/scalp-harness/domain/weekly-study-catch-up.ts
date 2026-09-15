/**
 * Whether a weekly-scheduled study run is overdue and should be run immediately on process startup,
 * rather than waiting for its next cron slot.
 *
 * ## Why a weekly job needs this and the frequent ticks do not
 *
 * `scalp-research-scheduler.ts`'s minute-level ticks get roughly 200 chances a day to fire; missing
 * one to a stalled timer (see `cron-liveness.ts`) costs a minute of capture, and the next tick 60
 * seconds later recovers on its own. `PATH_STUDY_V2`'s weekly run gets exactly **one** chance --
 * Saturday 07:00 IST -- so the same class of stall costs an entire week with no self-recovery: the
 * cron simply does not match again until next Saturday. Measured 2026-09-15: the study was last
 * declared 2026-08-25, three consecutive Saturdays with no run and no error, while the container kept
 * running throughout at least two of them.
 *
 * A stall-detecting watchdog that exits the process (the fix for the frequent ticks) only prevents
 * *future* misses -- restarting after a missed Saturday does not recover that week's run, because the
 * next `0 0 7 * * 6` match is still next Saturday. So this is a second, independent mechanism: on
 * every startup, check whether the study is *already* overdue and run it immediately if so, on top of
 * (not instead of) the normal weekly schedule.
 */
export function isWeeklyStudyOverdue(input: {
  readonly lastDeclaredAt: Date | null;
  readonly now: Date;
  /** How long a week's run may go missing before a fresh process should run it immediately. */
  readonly staleAfterMs: number;
}): boolean {
  if (input.staleAfterMs <= 0) {
    throw new Error("staleAfterMs must be positive; zero would run the study on every single startup.");
  }
  if (input.lastDeclaredAt === null) return true;
  return input.now.getTime() - input.lastDeclaredAt.getTime() > input.staleAfterMs;
}
