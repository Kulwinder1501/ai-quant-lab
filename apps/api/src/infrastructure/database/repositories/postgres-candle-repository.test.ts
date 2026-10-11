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
