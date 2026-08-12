import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { countUnrecoveredScheduledJobFailures } from "./postgres-scheduled-job-health-repository.js";

describe("countUnrecoveredScheduledJobFailures", () => {
  it("counts only failures with no later successful run of the same job", async () => {
    const query = vi.fn(async () => ({ rows: [{ count: "2" }] }));
    const database = { query } as unknown as DatabaseQueryable;

    await expect(countUnrecoveredScheduledJobFailures(
      database,
      ["OPTION_CHAIN", "OPTION_PREMIUM_TICKS"],
    )).resolves.toBe(2);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("recovered.status = 'COMPLETED'");
    expect(sql).toContain("recovered.claimed_at > failed.claimed_at");
    expect(parameters).toEqual([["OPTION_CHAIN", "OPTION_PREMIUM_TICKS"]]);
  });

  it("returns zero when there are no unrecovered failures", async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as DatabaseQueryable;

    await expect(countUnrecoveredScheduledJobFailures(database, ["OPTION_CHAIN"]))
      .resolves.toBe(0);
  });
});
