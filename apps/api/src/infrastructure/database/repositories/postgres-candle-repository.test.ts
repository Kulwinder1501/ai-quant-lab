import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresCandleRepository } from "./postgres-candle-repository.js";

function fakeDatabase(): { database: DatabaseQueryable; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [] }));
  return { database: { query } as unknown as DatabaseQueryable, query };
}

describe("PostgresCandleRepository.listCompleted", () => {
  it("requires the bar to have closed, not merely to be flagged complete", async () => {
    // Regression: filtering on is_complete alone let the pattern detector run on bars whose
    // close_time was still in the future (7% of recent 60m detections had detected_at < close_time).
    const { database, query } = fakeDatabase();

    await new PostgresCandleRepository(database).listCompleted("instrument-1", "60m");

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/is_complete = TRUE/);
    expect(sql).toMatch(/close_time <= COALESCE\(\$3::timestamptz, CURRENT_TIMESTAMP\)/);
    // No explicit instant means "the database's now", not the process clock.
    expect(params).toEqual(["instrument-1", "60m", null]);
  });

  it("accepts an explicit instant so replay and tests are deterministic", async () => {
    const { database, query } = fakeDatabase();
    const asOf = new Date("2026-10-09T10:00:00.000Z");

    await new PostgresCandleRepository(database).listCompleted("instrument-1", "5m", asOf);

    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["instrument-1", "5m", asOf]);
  });
});

describe("PostgresCandleRepository.listCompletedWindow", () => {
  it("counts the warm-up over the same closed, completed bars a full read returns", async () => {
    // The Nth bar back must be found among bars that listCompleted would have returned. Counting
    // over all rows would let a half-built bar sit inside the warm-up and shift the window by one.
    const { database, query } = fakeDatabase();
    const since = new Date("2026-10-25T00:00:00.000Z");

    await new PostgresCandleRepository(database).listCompletedWindow("instrument-1", "1m", since, 5000);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["instrument-1", "1m", since, 5000]);
    // Both the outer read and the subquery that finds where the window starts apply the rule.
    expect(sql.match(/is_complete = TRUE/g)).toHaveLength(2);
    expect(sql.match(/close_time <= CURRENT_TIMESTAMP/g)).toHaveLength(2);
    expect(sql).toMatch(/open_time < \$3/);
    expect(sql).toMatch(/ORDER BY open_time DESC\s+OFFSET \$4::int - 1 LIMIT 1/);
    // Fewer than N earlier bars: the whole series, not nothing.
    expect(sql).toMatch(/COALESCE\(\(/);
    expect(sql).toMatch(/'-infinity'::timestamptz/);
    expect(sql).toMatch(/ORDER BY open_time ASC\s*$/);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a warm-up of %s before touching the database", async (warmupBars) => {
    const { database, query } = fakeDatabase();

    await expect(new PostgresCandleRepository(database).listCompletedWindow("instrument-1", "1m", new Date(), warmupBars))
      .rejects.toThrow(/positive integer/);
    expect(query).not.toHaveBeenCalled();
  });
});
