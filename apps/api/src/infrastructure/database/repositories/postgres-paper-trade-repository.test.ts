import { Pool, type PoolClient } from "pg";
import type { DatabasePool } from "../database.js";
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from "vitest";
import { PostgresPaperTradeRepository } from "./postgres-paper-trade-repository.js";

describe("PostgresPaperTradeRepository manual option transaction", () => {
  it("rolls back the synthetic idea when opening the trade fails", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text.replace(/\s+/g, " ").trim());
        if (text.includes("INSERT INTO trade_ideas")) return { rows: [{ id: "idea-1" }] };
        if (text.includes("FROM paper_accounts")) return { rows: [] };
        return { rows: [] };
      }),
      release,
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const repository = new PostgresPaperTradeRepository(database);

    await expect(repository.openManualOption({
      accountId: "account-1",
      instrumentId: "instrument-1",
      quantity: 75,
      fillPrice: 100,
      openedAt: new Date("2026-08-09T10:00:00.000Z"),
      entryFees: 20,
      entrySlippage: 0,
      notes: "test",
      stopLossOverride: 50,
      targetPriceOverride: 200,
    })).rejects.toThrow("Paper account was not found or is inactive.");

    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((statement) => statement.startsWith("INSERT INTO trade_ideas"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  // Regression guard for the synthetic-idea INSERT. The client is mocked, so this cannot exercise
  // the real Postgres CHECK constraints -- instead it asserts that the literal values the INSERT
  // writes have the JSON types and sign those constraints require. This is the shape that once
  // shipped inverted (reasoning as an object, evidence as an array, risk_reward as 0), which threw a
  // raw 23514 on every call; the assertions below fail on each of those three mistakes.
  it("writes literals that satisfy the trade_ideas reasoning/evidence/risk_reward CHECK constraints", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text.replace(/\s+/g, " ").trim());
        if (text.includes("INSERT INTO trade_ideas")) return { rows: [{ id: "idea-1" }] };
        // Nothing back for the account lookup, so the open aborts right after the synthetic idea is
        // inserted -- the INSERT statement under test has already been captured by then.
        if (text.includes("FROM paper_accounts")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(new PostgresPaperTradeRepository(database).openManualOption({
      accountId: "account-1",
      instrumentId: "instrument-1",
      quantity: 75,
      fillPrice: 100,
      openedAt: new Date("2026-08-09T10:00:00.000Z"),
      entryFees: 20,
      entrySlippage: 0,
      notes: "test",
      stopLossOverride: 50,
      targetPriceOverride: 200,
    })).rejects.toThrow();

    const insert = statements.find((statement) => statement.startsWith("INSERT INTO trade_ideas"));
    expect(insert).toBeDefined();

    // Column order in the INSERT is `... reasoning, evidence ...`, so the two single-quoted JSON
    // literals (each starting with `[` or `{`) appear reasoning-first. `'LONG'`, `'PROPOSED'` and
    // `'1 day'` do not start with a bracket, so they are not matched.
    const jsonLiterals = [...insert!.matchAll(/'((?:\[|\{)[^']*(?:\]|\}))'(?:::jsonb)?/g)].map((match) => match[1]);
    expect(jsonLiterals).toHaveLength(2);
    const [reasoning, evidence] = jsonLiterals.map((literal) => JSON.parse(literal) as unknown);

    // reasoning JSONB NOT NULL CHECK (jsonb_typeof(reasoning) = 'array')
    expect(Array.isArray(reasoning)).toBe(true);
    // evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object')
    expect(evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)).toBe(true);

    // risk_reward NUMERIC NOT NULL CHECK (risk_reward > 0) -- the value between the $4 stop param and confidence.
    const riskReward = insert!.match(/\$4,\s*([0-9.]+)\s*,/);
    expect(riskReward).not.toBeNull();
    expect(Number(riskReward![1])).toBeGreaterThan(0);
  });

  it("rolls back the first structure leg when the second leg cannot open", async () => {
    const statements: string[] = [];
    let accountReads = 0;
    const release = vi.fn();
    const openedAt = new Date("2026-08-09T10:00:00.000Z");
    const client = {
      query: vi.fn(async (text: string) => {
        const normalized = text.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        if (text.includes("FROM paper_accounts") && text.includes("FOR UPDATE")) {
          accountReads += 1;
          return accountReads === 1
            ? { rows: [{ id: "account-1", name: "pair", opening_balance: "100000", currency: "INR", is_active: true }] }
            : { rows: [] };
        }
        if (text.includes("FROM trade_ideas") && text.includes("FOR UPDATE")) {
          return { rows: [{
            id: "idea-1", instrument_id: "instrument-1", side: "LONG",
            entry_price: "100", stop_loss: "90", target_price: "110",
            expires_at: null, lot_size: 75,
          }] };
        }
        if (text.includes("AS available_capital")) return { rows: [{ available_capital: "100000" }] };
        if (text.includes("INSERT INTO paper_trades")) return { rows: [{ id: "trade-1" }] };
        if (text.includes("UPDATE trade_ideas SET status = 'ACCEPTED'")) return { rows: [{ id: "idea-1" }] };
        // The one-position-per-idea-per-account check. Answered before the generic paper_trades
        // branch below, which exists for the trade lookup after the insert; left to fall through it
        // would report that this account had already traded the idea.
        if (text.includes("AND trade_idea_id = $2")) return { rows: [] };
        if (text.includes("FROM paper_trades")) {
          return { rows: [{
            id: "trade-1", account_id: "account-1", trade_idea_id: "idea-1",
            instrument_id: "instrument-1", timeframe: "5m", side: "LONG", status: "OPEN",
            quantity: "75", entry_price: "100", stop_loss: "90", target_price: "110",
            opened_at: openedAt, closed_at: null, exit_price: null, exit_reason: null,
            realized_pnl: null, fees: "20", fee_breakdown: {}, slippage: "0", notes: "pair",
            option_strike: null, option_expiry: null, option_type: null,
            underlying_symbol: null, underlying_entry_price: null, entry_iv: null,
          }] };
        }
        return { rows: [] };
      }),
      release,
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const repository = new PostgresPaperTradeRepository(database);
    const input = (tradeIdeaId: string) => ({
      accountId: "account-1",
      tradeIdeaId,
      quantity: 75,
      fillPrice: 100,
      openedAt,
      entryFees: 20,
      entrySlippage: 0,
      notes: "pair",
      stopLossOverride: 90,
      targetPriceOverride: 110,
    });

    await expect(repository.openPairFromTradeIdeas([
      input("idea-ce"), input("idea-pe"),
    ])).rejects.toThrow("Paper account was not found or is inactive.");

    expect(statements.filter((statement) => statement.startsWith("INSERT INTO paper_trades"))).toHaveLength(1);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("PostgresPaperTradeRepository timing boundaries", () => {
  it("moves opened_at and stop effectiveness to the actual pending fill time", async () => {
    const filledAt = new Date("2026-08-13T05:15:00.000Z");
    const statements: Array<{ text: string; parameters: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (text: string, parameters?: unknown[]) => {
        statements.push({ text: text.replace(/\s+/g, " ").trim(), parameters });
        if (text.includes("SELECT id FROM paper_trades")) return { rows: [{ id: "trade-1" }] };
        if (text.includes("FROM paper_trades") && !text.includes("SELECT id")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(new PostgresPaperTradeRepository(database).fillPendingTrade({
      paperTradeId: "trade-1",
      fillPrice: 180,
      filledAt,
    })).rejects.toThrow("Unable to resolve filled trade.");

    const update = statements.find((statement) => statement.text.startsWith("UPDATE paper_trades"));
    expect(update?.text).toContain("opened_at = $3");
    expect(update?.text).toContain("stop_loss_effective_at = $3");
    expect(update?.parameters).toEqual(["trade-1", 180, filledAt]);
  });

  it("timestamps every stop revision", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const database = { query } as unknown as DatabasePool;

    await new PostgresPaperTradeRepository(database).updateStopLoss("trade-1", 170, "tighten");

    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toContain("stop_loss_effective_at = CURRENT_TIMESTAMP");
  });
});

/**
 * `updateStopLoss`, against a real database.
 *
 * A mocked client cannot catch this class of bug: Postgres unifies every occurrence of one
 * placeholder into a single inferred type, and the query used to bind `$2` both as the (numeric)
 * `stop_loss` assignment and, separately, cast `$2::text` for the note -- which is exactly the shape
 * that throws "inconsistent types deduced for parameter $2" (42P08). It did not fail on every call
 * (the failure is plan-dependent), so it went unnoticed until it took down `AiAutonomousAgent.tick`
 * for NIFTY50 in production, 2026-09-16, on a real open position whose protective stop needed
 * tightening. A string-mock test would happily assert on the SQL text without ever asking Postgres
 * whether that text is actually valid.
 */
describe.skipIf(!process.env.DATABASE_URL)("PostgresPaperTradeRepository.updateStopLoss (live DB)", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertInstrument(symbol: string): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO instruments (exchange, symbol, display_name, instrument_type)
      VALUES ('NSE', $1, $1, 'INDEX')
      RETURNING id
    `, [symbol]);
    return result.rows[0]!.id;
  }

  async function insertAccount(name: string): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO paper_accounts (name, opening_balance)
      VALUES ($1, 1000000)
      RETURNING id
    `, [name]);
    return result.rows[0]!.id;
  }

  async function insertOpenTrade(input: { accountId: string; instrumentId: string }): Promise<string> {
    const now = new Date();
    const trade = await client.query<{ id: string }>(`
      INSERT INTO paper_trades (
        account_id, instrument_id, side, status, quantity, remaining_quantity,
        entry_price, stop_loss, initial_stop_loss, stop_loss_effective_at, target_price,
        opened_at
      ) VALUES ($1, $2, 'LONG', 'OPEN', 75, 75, 100, 90, 90, $3, 130, $3)
      RETURNING id
    `, [input.accountId, input.instrumentId, now]);
    return trade.rows[0]!.id;
  }

  it("moves the stop and records the note, on a real connection", async () => {
    const instrumentId = await insertInstrument("STOP-LOSS-TEST");
    const accountId = await insertAccount("stop-loss-test-account");
    const tradeId = await insertOpenTrade({ accountId, instrumentId });

    await new PostgresPaperTradeRepository(client as unknown as DatabasePool)
      .updateStopLoss(tradeId, 95.5, "tighten");

    const result = await client.query<{ stop_loss: string; notes: string | null }>(
      "SELECT stop_loss, notes FROM paper_trades WHERE id = $1", [tradeId],
    );
    expect(Number(result.rows[0]!.stop_loss)).toBe(95.5);
    expect(result.rows[0]!.notes).toContain("tighten to ₹95.5");
  });

  it("falls back to the default reason and still records the numeric note", async () => {
    const instrumentId = await insertInstrument("STOP-LOSS-TEST-2");
    const accountId = await insertAccount("stop-loss-test-account-2");
    const tradeId = await insertOpenTrade({ accountId, instrumentId });

    await new PostgresPaperTradeRepository(client as unknown as DatabasePool)
      .updateStopLoss(tradeId, 92);

    const result = await client.query<{ notes: string | null }>(
      "SELECT notes FROM paper_trades WHERE id = $1", [tradeId],
    );
    // The JS-level `reason || "Dynamic Stop-Loss Tightening"` default always supplies a non-null
    // string, so the SQL-level `COALESCE($3, 'SL Adjusted')` fallback is unreachable through this
    // method -- this asserts what actually happens, not what the SQL default alone would suggest.
    expect(result.rows[0]!.notes).toContain("Dynamic Stop-Loss Tightening to ₹92");
  });
});
