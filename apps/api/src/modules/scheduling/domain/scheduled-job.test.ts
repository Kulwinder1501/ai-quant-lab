import { describe, expect, it, vi } from "vitest";
import {
  runExclusively,
  toDueMinute,
  type ScheduledJobClaim,
  type ScheduledJobClaimRepository,
} from "./scheduled-job.js";

function claim(overrides: Partial<ScheduledJobClaim> = {}): ScheduledJobClaim {
  return {
    jobType: "EOD_PIPELINE",
    scheduledFor: new Date("2026-07-31T10:35:00.000Z"),
    claimedBy: "api-1",
    ...overrides,
  };
}

interface FakeRun { jobType: string; scheduledFor: Date; claimedAt: Date; status: "RUNNING" | "DONE" }

/**
 * Enforces the real uniqueness rule: one winner per (jobType, scheduledFor), and tracks
 * run status so the overlap guard is exercised against the same state the table holds.
 */
function sharedClaimStore(): ScheduledJobClaimRepository & {
  completed: string[]; failed: string[]; runs: FakeRun[];
} {
  const held = new Set<string>();
  const runs: FakeRun[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const key = (input: { jobType: string; scheduledFor: Date }) =>
    `${input.jobType}@${input.scheduledFor.toISOString()}`;
  const finish = (input: { jobType: string; scheduledFor: Date }) => {
    const run = runs.find((candidate) => key(candidate) === key(input) && candidate.status === "RUNNING");
    if (run) run.status = "DONE";
  };
  return {
    completed,
    failed,
    runs,
    claim: async (input) => {
      if (held.has(key(input))) return false;
      held.add(key(input));
      runs.push({ jobType: input.jobType, scheduledFor: input.scheduledFor, claimedAt: input.scheduledFor, status: "RUNNING" });
      return true;
    },
    complete: async (input) => { completed.push(key(input)); finish(input); },
    fail: async (input, errorDetails) => { failed.push(`${key(input)}:${errorDetails}`); finish(input); },
    abandonStaleRuns: async (jobType, abandonedBefore) => {
      const stale = runs.filter((run) =>
        run.jobType === jobType && run.status === "RUNNING" && run.claimedAt.getTime() < abandonedBefore.getTime());
      for (const run of stale) run.status = "DONE";
      return stale.length;
    },
    countRunning: async (jobType) =>
      runs.filter((run) => run.jobType === jobType && run.status === "RUNNING").length,
  };
}

describe("toDueMinute", () => {
  it("collapses instants within the same minute to one key", () => {
    // Two instances woken by the same cron tick are milliseconds apart; without this
    // they would compute different keys and both would win their own claim.
    const first = toDueMinute(new Date("2026-07-31T10:35:00.004Z"));
    const second = toDueMinute(new Date("2026-07-31T10:35:59.998Z"));

    expect(first.toISOString()).toBe("2026-07-31T10:35:00.000Z");
    expect(first.getTime()).toBe(second.getTime());
  });

  it("keeps different minutes distinct", () => {
    expect(toDueMinute(new Date("2026-07-31T10:35:30.000Z")).getTime())
      .not.toBe(toDueMinute(new Date("2026-07-31T10:36:30.000Z")).getTime());
  });

  it("does not mutate its argument", () => {
    const instant = new Date("2026-07-31T10:35:42.123Z");
    toDueMinute(instant);
    expect(instant.toISOString()).toBe("2026-07-31T10:35:42.123Z");
  });
});

describe("runExclusively", () => {
  it("runs the task exactly once when several instances fire the same due minute", async () => {
    const repository = sharedClaimStore();
    const task = vi.fn(async () => {});

    const results = await Promise.all([
      runExclusively(repository, claim({ claimedBy: "api-1" }), task),
      runExclusively(repository, claim({ claimedBy: "api-2" }), task),
      runExclusively(repository, claim({ claimedBy: "api-3" }), task),
    ]);

    expect(task).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(repository.completed).toEqual(["EOD_PIPELINE@2026-07-31T10:35:00.000Z"]);
  });

  it("lets the same job run again at a later due minute", async () => {
    const repository = sharedClaimStore();
    const task = vi.fn(async () => {});

    await runExclusively(repository, claim(), task);
    await runExclusively(repository, claim({ scheduledFor: new Date("2026-08-01T10:35:00.000Z") }), task);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not treat losing the claim as an error", async () => {
    const repository = sharedClaimStore();
    await runExclusively(repository, claim(), async () => {});

    const loser = await runExclusively(repository, claim({ claimedBy: "api-2" }), async () => {
      throw new Error("must not run");
    });

    expect(loser).toMatchObject({ ran: false, failed: false, skippedReason: "CLAIMED_BY_PEER" });
  });

  it("records a failure and rethrows so the caller can log it", async () => {
    const repository = sharedClaimStore();

    await expect(runExclusively(repository, claim(), async () => {
      throw new Error("pipeline exploded");
    })).rejects.toThrow("pipeline exploded");

    expect(repository.failed).toEqual(["EOD_PIPELINE@2026-07-31T10:35:00.000Z:pipeline exploded"]);
    expect(repository.completed).toEqual([]);
  });

  it("does not free the due minute after a failure, so a peer cannot immediately re-run it", async () => {
    const repository = sharedClaimStore();
    await expect(runExclusively(repository, claim(), async () => {
      throw new Error("first attempt failed");
    })).rejects.toThrow();

    const peer = vi.fn(async () => {});
    const result = await runExclusively(repository, claim({ claimedBy: "api-2" }), peer);

    // A failed EOD run has still consumed its due minute; retrying it concurrently
    // would mean two training runs.
    expect(result.ran).toBe(false);
    expect(peer).not.toHaveBeenCalled();
  });

  it("does not start a second copy while the previous run is still going", async () => {
    // The pileup this exists to stop: INDICES_INTRADAY is a `*/1` cron over a job that
    // takes longer than a minute. The claim key is per minute, so every tick won its own
    // claim and started another copy -- 330 concurrent runs, one completion in 72 hours.
    const repository = sharedClaimStore();
    let release = (): void => {};
    let markStarted = (): void => {};
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const task = vi.fn(() => { markStarted(); return inFlight; });

    const first = runExclusively(
      repository,
      claim({ jobType: "INDICES_INTRADAY", scheduledFor: new Date("2026-08-07T06:31:00.000Z") }),
      task,
      { overlap: "SKIP", now: new Date("2026-08-07T06:31:00.000Z") },
    );
    // Wait for the first run to actually be in flight; otherwise the second call can win
    // the race to `countRunning` and the test would assert on interleaving, not on the guard.
    await started;
    const second = await runExclusively(
      repository,
      claim({ jobType: "INDICES_INTRADAY", scheduledFor: new Date("2026-08-07T06:32:00.000Z") }),
      task,
      { overlap: "SKIP", now: new Date("2026-08-07T06:32:00.000Z") },
    );

    expect(second).toMatchObject({ ran: false, skippedReason: "PREVIOUS_RUN_UNFINISHED" });
    expect(task).toHaveBeenCalledTimes(1);
    // Skipping must not record a run: nothing happened, and a phantom row would make the
    // job-health endpoint read as though it had.
    expect(repository.runs).toHaveLength(1);

    release();
    await first;
    expect((await runExclusively(
      repository,
      claim({ jobType: "INDICES_INTRADAY", scheduledFor: new Date("2026-08-07T06:33:00.000Z") }),
      task,
      { overlap: "SKIP", now: new Date("2026-08-07T06:33:00.000Z") },
    )).ran).toBe(true);
  });

  it("recovers when the previous claimant was killed rather than merely slow", async () => {
    // A row only leaves RUNNING via the process that claimed it, so a container restart
    // strands it forever. Without the staleness sweep the overlap guard would then block
    // the job permanently -- a worse failure than the one it prevents.
    const repository = sharedClaimStore();
    await repository.claim({
      jobType: "INDICES_INTRADAY",
      scheduledFor: new Date("2026-08-07T05:00:00.000Z"),
      claimedBy: "dead-container",
    });
    const task = vi.fn(async () => {});

    const result = await runExclusively(
      repository,
      claim({ jobType: "INDICES_INTRADAY", scheduledFor: new Date("2026-08-07T06:31:00.000Z") }),
      task,
      { overlap: "SKIP", abandonedAfterMs: 10 * 60 * 1000, now: new Date("2026-08-07T06:31:00.000Z") },
    );

    expect(result).toMatchObject({ ran: true, abandonedRuns: 1 });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not write off a run that is merely slower than usual", async () => {
    // The horizon has to exceed the job's longest honest run. Declaring a working run
    // abandoned frees the guard and starts a second copy -- the pileup, reintroduced.
    const repository = sharedClaimStore();
    await repository.claim({
      jobType: "EOD_PIPELINE",
      scheduledFor: new Date("2026-08-07T06:00:00.000Z"),
      claimedBy: "still-training",
    });

    const result = await runExclusively(
      repository,
      claim({ jobType: "EOD_PIPELINE", scheduledFor: new Date("2026-08-07T06:31:00.000Z") }),
      async () => { throw new Error("must not run"); },
      { overlap: "SKIP", abandonedAfterMs: 6 * 60 * 60 * 1000, now: new Date("2026-08-07T06:31:00.000Z") },
    );

    expect(result).toMatchObject({ ran: false, skippedReason: "PREVIOUS_RUN_UNFINISHED", abandonedRuns: 0 });
  });

  it("leaves overlapping runs alone unless asked to skip", async () => {
    const repository = sharedClaimStore();
    await repository.claim({ jobType: "RSS_NEWS_INGESTION", scheduledFor: new Date("2026-08-07T06:00:00.000Z"), claimedBy: "peer" });
    const task = vi.fn(async () => {});

    const result = await runExclusively(
      repository,
      claim({ jobType: "RSS_NEWS_INGESTION", scheduledFor: new Date("2026-08-07T06:03:00.000Z") }),
      task,
    );

    expect(result.ran).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct job types independent at the same due minute", async () => {
    const repository = sharedClaimStore();
    const eod = vi.fn(async () => {});
    const flows = vi.fn(async () => {});

    await runExclusively(repository, claim({ jobType: "EOD_PIPELINE" }), eod);
    await runExclusively(repository, claim({ jobType: "INSTITUTIONAL_FLOWS" }), flows);

    expect(eod).toHaveBeenCalledTimes(1);
    expect(flows).toHaveBeenCalledTimes(1);
  });
});
