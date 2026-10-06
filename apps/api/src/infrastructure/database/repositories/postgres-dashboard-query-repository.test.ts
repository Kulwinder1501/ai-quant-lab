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

describe("PostgresDashboardQueryRepository fee legs", () => {
  it("splits entry and exit from the stored breakdown instead of reporting the total as entry", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const database = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        if (text.includes("FROM paper_accounts")) {
          return { rows: [{ id: "a1", name: "AutoBot", opening_balance: 100000, currency: "INR", is_active: true }] };
        }
        if (text.includes("FROM paper_trades")) {
          return {
            rows: [{
              id: "t1", account_id: "a1", instrument_id: "i1", trade_idea_id: null, timeframe: "5m",
              side: "LONG", status: "CLOSED", quantity: 75, entry_price: 89.4, stop_loss: 80, target_price: 110,
              opened_at: new Date("2026-09-03T09:35:00Z"), closed_at: new Date("2026-09-03T09:44:27Z"),
              exit_price: 81.6, exit_reason: "STOP_LOSS", realized_pnl: -643.84,
              // The two legs of a real trade: 26.58 in, 32.26 out, 58.84 total.
              fees: 58.84, entry_fees: 26.58, exit_fees: 32.26,
              fee_breakdown: { entry: { total: 26.58 }, exit: { total: 32.26 } },
              slippage: 0, notes: "", option_strike: 23900, option_expiry: null, option_type: "PE",
              underlying_symbol: "NIFTY50", entry_iv: null,
              instrument_symbol: "NIFTY50", instrument_name: "NIFTY 50",
            }],
          };
        }
        return { rows: [] };
      },
    } as unknown as DatabaseQueryable;

    const summary = await new PostgresDashboardQueryRepository(database)
      .getPaperAccountFullSummary("a1", {});
    const trade = summary.closedTrades[0] as Record<string, number>;

    expect(trade.entryFees).toBe(26.58);
    // The regression: this was hardcoded 0, so the response asserted every exit was free.
    expect(trade.exitFees).toBe(32.26);
    expect(trade.totalFees).toBe(58.84);
    // The invariant that makes the SQL fallback safe, and that the UI's gross figure relies on.
    expect(trade.entryFees + trade.exitFees).toBeCloseTo(trade.totalFees, 2);
  });

  it("asks the database to split the legs rather than doing it in TypeScript", async () => {
    const calls: string[] = [];
    const database = {
      query: async (text: string) => { calls.push(text); return { rows: [] }; },
    } as unknown as DatabaseQueryable;

    await new PostgresDashboardQueryRepository(database).getPaperAccountFullSummary("a1", {});
    const tradeQuery = calls.find((text) => text.includes("FROM paper_trades"));

    expect(tradeQuery).toContain("AS entry_fees");
    expect(tradeQuery).toContain("AS exit_fees");
  });
});
