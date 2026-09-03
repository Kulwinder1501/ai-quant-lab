import { describe, expect, it } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresDashboardQueryRepository } from "./postgres-dashboard-query-repository.js";

/**
 * The trade-idea strategy filter, which takes a list and not just one key.
 *
 * Against a fake queryable rather than a live database, deliberately: what broke was the SQL text
 * and the bound parameter, not the rows. A dashboard build asked for six scalp keys at once, the
 * filter compared `strategy_key` to the whole joined string by equality, and no row can hold
 * "a,b,c" -- so the Scalp tab rendered zero proposals while 1,408 sat in the table. A live-DB test
 * would prove the query returns rows; these assert the shape that made it return none.
 */
function captureQueries(): { calls: { text: string; params: unknown[] }[]; database: DatabaseQueryable } {
  const calls: { text: string; params: unknown[] }[] = [];
  const database = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    },
  } as unknown as DatabaseQueryable;
  return { calls, database };
}

async function listWith(strategy?: string, dateStr?: string): Promise<{ text: string; params: unknown[] }> {
  const { calls, database } = captureQueries();
  await new PostgresDashboardQueryRepository(database).listTradeIdeas(100, dateStr, strategy, true);
  const call = calls[0];
  if (!call) throw new Error("listTradeIdeas issued no query");
  return call;
}

describe("PostgresDashboardQueryRepository.listTradeIdeas strategy filter", () => {
  it("binds a single key as a one-element array", async () => {
    const { text, params } = await listWith("momentum-scalp");

    expect(text).toContain("s.strategy_key = ANY($2::text[])");
    expect(params[1]).toEqual(["momentum-scalp"]);
  });

  it("matches every key in a comma-separated list", async () => {
    // The exact value the Scalp tab sends: four operational strategies plus two research twins.
    const { text, params } = await listWith(
      "momentum-scalp,momentum-scalp-index,momentum-scalp-pattern,momentum-scalp-pattern-v2,"
      + "pattern-v4-research,pattern-v4-research-v2",
    );

    expect(text).toContain("s.strategy_key = ANY($2::text[])");
    expect(params[1]).toEqual([
      "momentum-scalp",
      "momentum-scalp-index",
      "momentum-scalp-pattern",
      "momentum-scalp-pattern-v2",
      "pattern-v4-research",
      "pattern-v4-research-v2",
    ]);
  });

  it("never compares the joined list to a single column value", async () => {
    const { text } = await listWith("momentum-scalp,momentum-scalp-index");

    // The regression itself: `strategy_key = $n` can only ever match a row whose key *is* the
    // comma-joined string, so this shape must not come back.
    expect(text).not.toMatch(/s\.strategy_key = \$\d/);
  });

  it("trims surrounding whitespace and drops empty entries", async () => {
    const { params } = await listWith(" momentum-scalp , , momentum-scalp-index ,");

    expect(params[1]).toEqual(["momentum-scalp", "momentum-scalp-index"]);
  });

  it("omits the filter when the list parses to nothing", async () => {
    const { text, params } = await listWith(",, ,");

    // Matches how the route already treats `strategy=`, which `strategy || undefined` turns into no
    // filter at all. Binding an empty array instead would return zero rows for a caller that asked
    // for no particular strategy.
    // `s.strategy_key` still appears in the SELECT list, so the assertion is that no predicate was
    // built at all: with includeExpired and no date, an omitted strategy leaves zero conditions.
    expect(text).not.toContain("WHERE");
    expect(text).not.toContain("ANY(");
    expect(params).toEqual([100]);
  });

  it("numbers the placeholder after an earlier date parameter", async () => {
    const { text, params } = await listWith("momentum-scalp-index", "2026-09-03");

    expect(text).toContain("s.strategy_key = ANY($3::text[])");
    expect(params[1]).toBe("2026-09-03");
    expect(params[2]).toEqual(["momentum-scalp-index"]);
  });
});
