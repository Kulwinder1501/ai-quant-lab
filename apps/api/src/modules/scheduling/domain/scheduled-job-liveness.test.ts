import { describe, expect, it } from "vitest";
import { findOverdueScheduledJobs } from "./scheduled-job-liveness.js";

const MINUTE = 60_000;
const NOW = new Date("2026-08-17T06:45:00.000Z");
const SINCE = new Date("2026-08-17T03:45:00.000Z");

describe("findOverdueScheduledJobs", () => {
  it("reports nothing when every job completed within its tolerance", () => {
    const overdue = findOverdueScheduledJobs({
      expectations: [{ jobType: "OPTION_CHAIN", intervalMs: 15 * MINUTE }],
      lastCompletedAt: new Map([["OPTION_CHAIN", new Date("2026-08-17T06:30:00.000Z")]]),
      now: NOW,
      since: SINCE,
    });
    expect(overdue).toEqual([]);
  });

  it("tolerates a stutter, because a skipped tick is normal", () => {
    // One missed 15-minute tick is a skip or a single failure, not a stopped job.
    const overdue = findOverdueScheduledJobs({
      expectations: [{ jobType: "OPTION_CHAIN", intervalMs: 15 * MINUTE }],
      lastCompletedAt: new Map([["OPTION_CHAIN", new Date("2026-08-17T06:15:00.000Z")]]),
      now: NOW,
      since: SINCE,
    });
    expect(overdue).toEqual([]);
  });

  it("catches the real outage: completions stop while the process keeps running", () => {
    // The measured incident. OPTION_CHAIN last completed 05:45 and produced no row at 06:15 or
    // 06:30, which is exactly what no failure-counting check can see.
    const overdue = findOverdueScheduledJobs({
      expectations: [{ jobType: "OPTION_CHAIN", intervalMs: 15 * MINUTE }],
      lastCompletedAt: new Map([["OPTION_CHAIN", new Date("2026-08-17T05:45:00.000Z")]]),
      now: NOW,
      since: SINCE,
    });
    expect(overdue).toEqual([{
      jobType: "OPTION_CHAIN",
      lastCompletedAt: new Date("2026-08-17T05:45:00.000Z"),
      silentForMs: 60 * MINUTE,
      toleratedSilenceMs: 45 * MINUTE,
    }]);
  });

  it("measures from the window opening when a job has never completed", () => {
    const overdue = findOverdueScheduledJobs({
      expectations: [{ jobType: "NEVER_RAN", intervalMs: 5 * MINUTE }],
      lastCompletedAt: new Map(),
      now: NOW,
      since: SINCE,
    });
    expect(overdue[0]).toMatchObject({ jobType: "NEVER_RAN", lastCompletedAt: null, silentForMs: 180 * MINUTE });
  });

  it("ignores a completion from before the window, which says nothing about this session", () => {
    const overdue = findOverdueScheduledJobs({
      expectations: [{ jobType: "OPTION_CHAIN", intervalMs: 15 * MINUTE }],
      lastCompletedAt: new Map([["OPTION_CHAIN", new Date("2026-08-14T09:00:00.000Z")]]),
      now: NOW,
      since: SINCE,
    });
    // Yesterday's success must not vouch for today, so this is measured from `since`.
    expect(overdue[0]).toMatchObject({ jobType: "OPTION_CHAIN", silentForMs: 180 * MINUTE });
  });

  it("honours a per-job tolerance", () => {
    const expectations = [{ jobType: "PAPER_TRADING_BOT", intervalMs: 5 * MINUTE, toleratedIntervals: 12 }];
    const lastCompletedAt = new Map([["PAPER_TRADING_BOT", new Date("2026-08-17T05:55:00.000Z")]]);
    expect(findOverdueScheduledJobs({ expectations, lastCompletedAt, now: NOW, since: SINCE })).toEqual([]);

    const later = new Date("2026-08-17T07:00:00.000Z");
    expect(findOverdueScheduledJobs({ expectations, lastCompletedAt, now: later, since: SINCE })).toHaveLength(1);
  });

  it("reports the longest silence first, since it is the likeliest to have starved something", () => {
    const overdue = findOverdueScheduledJobs({
      expectations: [
        { jobType: "SHORTER", intervalMs: 15 * MINUTE },
        { jobType: "LONGER", intervalMs: 15 * MINUTE },
      ],
      lastCompletedAt: new Map([
        ["SHORTER", new Date("2026-08-17T05:45:00.000Z")],
        ["LONGER", new Date("2026-08-17T04:45:00.000Z")],
      ]),
      now: NOW,
      since: SINCE,
    });
    expect(overdue.map((job) => job.jobType)).toEqual(["LONGER", "SHORTER"]);
  });
});
