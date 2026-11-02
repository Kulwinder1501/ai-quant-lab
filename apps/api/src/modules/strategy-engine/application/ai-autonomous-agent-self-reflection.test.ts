import { describe, expect, it, vi } from "vitest";
import { AiAutonomousAgent } from "./ai-autonomous-agent.js";

/**
 * `generateSelfReflection` reviews a closed paper trade, and its first statement selected `trade_ideas.strategy_name`, a column that does
 * not exist. From 2026-10-15 every call failed with `column trade_ideas.strategy_name does not exist`, which `/agent/performance` returned
 * as a 500 and the dashboard's performance panel could not load. No test ran the statement, so nothing noticed.
 *
 * There is no database here, so this pins what the statement may reference instead: every `trade_ideas.<column>` must be a column the
 * table really has, and the strategy label must come through the version tables.
 */

/** The columns of `trade_ideas`, from the live schema (migration 001 and its later additions). Extend this when a migration adds one. */
const TRADE_IDEAS_COLUMNS = new Set([
  "id", "instrument_id", "strategy_version_id", "model_version_id", "source_candle_id", "side", "status", "entry_price", "stop_loss",
  "target_price", "risk_reward", "confidence", "reasoning", "evidence", "generated_at", "expires_at", "updated_at",
]);

async function statementsIssuedFor(tradeId: string): Promise<string[]> {
  const statements: string[] = [];
  // No row comes back, so the method returns right after its first statement, which is the one under test.
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    return { rows: [] };
  });
  const pool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as never;
  const agent = new AiAutonomousAgent(pool, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  await agent.generateSelfReflection(tradeId, "NIFTY50");
  return statements;
}

describe("generateSelfReflection's trade statement", () => {
  it("issues one statement for the trade, with the trade id as its parameter", async () => {
    const statements = await statementsIssuedFor("trade-1");
    expect(statements.filter((sql) => /FROM paper_trades/i.test(sql))).toHaveLength(1);
  });

  it("references only columns that trade_ideas has", async () => {
    const [sql] = (await statementsIssuedFor("trade-1")).filter((statement) => /FROM paper_trades/i.test(statement));
    const referenced = [...sql.matchAll(/trade_ideas\.([a-z_]+)/g)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((column) => !TRADE_IDEAS_COLUMNS.has(column));
    expect(missing).toEqual([]);
  });

  it("reads the setup family from the strategy key, joined through the idea's strategy version", async () => {
    const [sql] = (await statementsIssuedFor("trade-1")).filter((statement) => /FROM paper_trades/i.test(statement));
    expect(sql).toMatch(/strategies\.strategy_key\s+AS\s+setup_family/i);
    expect(sql).toMatch(/JOIN strategy_versions ON strategy_versions\.id = trade_ideas\.strategy_version_id/i);
    expect(sql).toMatch(/JOIN strategies ON strategies\.id = strategy_versions\.strategy_id/i);
  });

  it("leaves a trade with no idea in the result (a left join), so a trade the agent did not propose is still reviewed", async () => {
    const [sql] = (await statementsIssuedFor("trade-1")).filter((statement) => /FROM paper_trades/i.test(statement));
    expect(sql).toMatch(/LEFT JOIN trade_ideas/i);
    expect(sql).toMatch(/LEFT JOIN strategy_versions/i);
    expect(sql).toMatch(/LEFT JOIN strategies/i);
  });
});
