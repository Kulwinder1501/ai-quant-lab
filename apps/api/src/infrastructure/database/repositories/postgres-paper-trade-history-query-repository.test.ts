import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresPaperTradeHistoryQueryRepository } from "./postgres-paper-trade-history-query-repository.js";

describe("PostgresPaperTradeHistoryQueryRepository", () => {
  it("matches an IST activity day against either open or close time", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [] };
      }),
    } as unknown as DatabaseQueryable;
    const repository = new PostgresPaperTradeHistoryQueryRepository(database);
    const from = new Date("2026-08-19T18:30:00.000Z");
    const toExclusive = new Date("2026-08-20T18:30:00.000Z");

    await repository.list({ activityFrom: from, activityToExclusive: toExclusive, limit: 501 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("pt.opened_at >= $1 AND pt.opened_at < $2");
    expect(calls[0]?.text).toContain("pt.closed_at >= $1 AND pt.closed_at < $2");
    expect(calls[0]?.values).toEqual([from, toExclusive, 501]);
  });
});
