import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresScalpResearchQueryRepository } from "./postgres-scalp-research-query-repository.js";

describe("PostgresScalpResearchQueryRepository", () => {
  it("types the matching-window parameter as a timestamp", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresScalpResearchQueryRepository(
      { query } as unknown as DatabaseQueryable,
    );
    await repository.listControlsForOpportunity({
      instrumentId: "instrument",
      sessionId: "2026-08-21",
      direction: "LONG",
      decisionAt: new Date("2026-08-21T10:00:00Z"),
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("$4::timestamptz - INTERVAL '15 minutes'");
    expect(sql).toContain("$4::timestamptz + INTERVAL '15 minutes'");
  });
});
