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

/** Enforces the real uniqueness rule: one winner per (jobType, scheduledFor). */
function sharedClaimStore(): ScheduledJobClaimRepository & { completed: string[]; failed: string[] } {
  const held = new Set<string>();
  const completed: string[] = [];
  const failed: string[] = [];
  const key = (input: { jobType: string; scheduledFor: Date }) =>
    `${input.jobType}@${input.scheduledFor.toISOString()}`;
  return {
    completed,
    failed,
    claim: async (input) => {
      if (held.has(key(input))) return false;
      held.add(key(input));
      return true;
    },
    complete: async (input) => { completed.push(key(input)); },
    fail: async (input, errorDetails) => { failed.push(`${key(input)}:${errorDetails}`); },
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

    expect(loser).toEqual({ ran: false, failed: false });
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
