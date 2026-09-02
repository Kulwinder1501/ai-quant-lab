import type { DatabasePool } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { PostgresPaperTradeRepository } from "./postgres-paper-trade-repository.js";

/**
 * Locks the meaning of `paper_trades.realized_pnl` to *net of all fees and slippage*, across both
 * writers that can set `status = 'CLOSED'`.
 *
 * ## Why this exists
 *
 * The P11 three-layer reconciliation flags one trade whose `realized_pnl` is gross where the other
 * 329 are net. The natural suspicion was that the two close paths disagreed -- that a full exit
 * booked gross while a partial exit booked net. That was investigated against the code and the
 * database and is not what happened: the paths have shared one closing expression since `fe84dc6`,
 * and the outlier carries none of the five artifacts either path writes (no close event, no slice
 * row, `remaining_quantity` never decremented, no `fee_breakdown.exit`). It was closed by hand.
 *
 * So there is no divergence to fix, and this file is the guard that keeps it that way. The
 * convention was only ever implicit in two separately-maintained SQL strings, which is precisely the
 * condition under which they drift apart without anyone noticing -- the reconciliation would then
 * report a rising residual count with no commit obviously to blame.
 *
 * ## What it asserts, and why by string comparison
 *
 * The P&L is computed *in SQL*, so a mocked client cannot evaluate it. What a mock can do is capture
 * the statements each path emits and assert they are the same where it matters. The central
 * assertion extracts the `realized_pnl = ...` expression from each path's closing UPDATE and
 * requires the two to be character-identical after whitespace normalisation. That is a deliberately
 * brittle assertion: any edit to one path's expression that is not mirrored in the other fails here,
 * which is the whole point.
 *
 * The slice-level assertions carry the other half. The closing expression sums
 * `paper_trade_partial_exits.realized_pnl`, so the column is only net if each slice is net; that
 * subtraction happens in TypeScript and is checked numerically below.
 */

const OPEN_TRADE_ROW = {
  id: "trade-1",
  account_id: "account-1",
  trade_idea_id: "idea-1",
  instrument_id: "instrument-1",
  timeframe: "5m",
  side: "LONG" as const,
  status: "OPEN" as const,
  quantity: "75",
  remaining_quantity: "75",
  entry_price: "212.95",
  stop_loss: "203.17",
  stop_loss_effective_at: new Date("2026-08-31T09:25:00.000Z"),
  target_price: "226.52",
  opened_at: new Date("2026-08-31T09:25:00.000Z"),
  closed_at: null,
  exit_price: null,
  exit_reason: null,
  realized_pnl: null,
  fees: "30.7",
  fee_breakdown: { entry: { total: 30.7 } },
  slippage: "0",
  notes: "test",
  option_strike: null,
  option_expiry: null,
  option_type: null,
  underlying_symbol: null,
  underlying_entry_price: null,
  entry_iv: null,
  regime_observation_id: null,
};

interface Captured {
  readonly text: string;
  readonly params: readonly unknown[];
}

function buildClient(captured: Captured[]) {
  return {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      captured.push({ text: text.replace(/\s+/g, " ").trim(), params });
      if (text.includes("FROM paper_trades") && text.includes("FOR UPDATE")) {
        return { rows: [OPEN_TRADE_ROW] };
      }
      if (text.includes("FROM paper_accounts")) return { rows: [{ id: "account-1" }] };
      if (text.includes("RETURNING id, realized_pnl, fees, slippage")) {
        return { rows: [{ id: "trade-1", realized_pnl: "-764.2", fees: "30.7", slippage: "0" }] };
      }
      // findPaperTradeById, called after the close to return the settled row.
      if (text.includes("FROM paper_trades")) {
        return { rows: [{ ...OPEN_TRADE_ROW, status: "CLOSED", remaining_quantity: "0" }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function repositoryOver(captured: Captured[]) {
  const client = buildClient(captured);
  const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
  return new PostgresPaperTradeRepository(database);
}

/** The closing UPDATE: the one that sets `status = 'CLOSED'`. */
function closingUpdate(captured: Captured[]): Captured {
  const update = captured.find((statement) =>
    statement.text.startsWith("UPDATE paper_trades") && statement.text.includes("status = 'CLOSED'"));
  if (!update) throw new Error("No closing UPDATE was captured.");
  return update;
}

/**
 * The `realized_pnl = ...` right-hand side, stopping at the UPDATE's own WHERE clause.
 *
 * The lazy quantifier is what steps over the subquery's inner `WHERE paper_trade_id = $1` -- that
 * clause cannot match this pattern, because after `WHERE ` the expression requires either `id` or
 * `paper_trades.id`, and `paper_trade_id` is neither.
 */
function realizedPnlExpression(update: Captured): string {
  const match = /realized_pnl = (.*?) WHERE (?:paper_trades\.)?id = \$1/.exec(update.text);
  if (!match?.[1]) throw new Error(`No realized_pnl expression in: ${update.text}`);
  return match[1];
}

function sliceInsert(captured: Captured[]): Captured {
  const insert = captured.find((statement) => statement.text.includes("INSERT INTO paper_trade_partial_exits"));
  if (!insert) throw new Error("No partial-exit slice INSERT was captured.");
  return insert;
}

const EXIT_PRICE = 203.17;
const EXIT_FEES = 28.4;
const EXIT_SLIPPAGE = 1.5;
// LONG 75 @ 212.95 out at 203.17.
const GROSS = (EXIT_PRICE - 212.95) * 75;

async function runFullClose(): Promise<Captured[]> {
  const captured: Captured[] = [];
  await repositoryOver(captured).close({
    paperTradeId: "trade-1",
    exitPrice: EXIT_PRICE,
    exitReason: "STOP_LOSS",
    exitFees: EXIT_FEES,
    exitSlippage: EXIT_SLIPPAGE,
    closedAt: new Date("2026-08-31T10:00:00.000Z"),
    details: {},
  });
  return captured;
}

async function runFinalSlice(): Promise<Captured[]> {
  const captured: Captured[] = [];
  await repositoryOver(captured).executeExitSlice({
    paperTradeId: "trade-1",
    // The whole remaining quantity, so the slice path takes its fully-closed branch.
    quantity: 75,
    exitPrice: EXIT_PRICE,
    exitReason: "STOP_LOSS",
    exitFees: EXIT_FEES,
    exitSlippage: EXIT_SLIPPAGE,
    exitedAt: new Date("2026-08-31T10:00:00.000Z"),
  });
  return captured;
}

describe("realized_pnl convention across both close paths", () => {
  it("computes realized_pnl with an identical expression in close() and executeExitSlice()", async () => {
    const fullClose = realizedPnlExpression(closingUpdate(await runFullClose()));
    const finalSlice = realizedPnlExpression(closingUpdate(await runFinalSlice()));

    expect(fullClose).toBe(finalSlice);
    // Pinned, so that "identical" cannot be satisfied by both paths drifting together into gross.
    expect(fullClose).toBe(
      "( SELECT COALESCE(SUM(realized_pnl), 0) FROM paper_trade_partial_exits WHERE paper_trade_id = $1 ) "
      + "- COALESCE((fee_breakdown->'entry'->>'total')::numeric, 0)",
    );
  });

  it("books each slice net of its own exit fees and slippage on both paths", async () => {
    const expected = GROSS - EXIT_FEES - EXIT_SLIPPAGE;

    for (const captured of [await runFullClose(), await runFinalSlice()]) {
      // (paper_trade_id, exit_price, quantity, exit_reason, exit_fees, realized_pnl, ...)
      const sliceRealizedPnl = sliceInsert(captured).params[5] as number;
      expect(sliceRealizedPnl).toBeCloseTo(expected, 9);
      // The gross figure is never what lands in the column.
      expect(sliceRealizedPnl).not.toBeCloseTo(GROSS, 6);
    }
  });

  it("subtracts the entry fee exactly once, from fee_breakdown rather than the fees column", async () => {
    for (const captured of [await runFullClose(), await runFinalSlice()]) {
      const expression = realizedPnlExpression(closingUpdate(captured));
      const entryFeeSubtractions = expression.match(/fee_breakdown->'entry'->>'total'/g) ?? [];
      expect(entryFeeSubtractions).toHaveLength(1);
      /*
       * `fees` is the running total of entry *and* exit fees, and the slices have already netted the
       * exit side. Subtracting the column here would double-count every exit fee.
       */
      expect(expression).not.toMatch(/\bfees\b/);
    }
  });

  it("records the entry fee where the closing expression reads it, so it cannot COALESCE to zero", async () => {
    const captured: Captured[] = [];
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        captured.push({ text: text.replace(/\s+/g, " ").trim(), params });
        if (text.includes("INSERT INTO trade_ideas")) return { rows: [{ id: "idea-1" }] };
        if (text.includes("INSERT INTO paper_trades")) return { rows: [{ id: "trade-1" }] };
        if (text.includes("UPDATE trade_ideas")) return { rows: [{ id: "idea-1" }] };
        if (text.includes("FROM paper_accounts") && text.includes("daily_trade_cap")) {
          return {
            rows: [{
              id: "account-1",
              name: "test",
              opening_balance: "1000000",
              currency: "INR",
              is_active: true,
              daily_trade_cap: null,
            }],
          };
        }
        if (text.includes("available_capital")) return { rows: [{ available_capital: "1000000" }] };
        if (text.includes("FROM trade_ideas")) {
          return {
            rows: [{
              id: "idea-1",
              instrument_id: "instrument-1",
              side: "LONG",
              entry_price: "212.95",
              stop_loss: "203.17",
              target_price: "226.52",
              expires_at: null,
              lot_size: 75,
            }],
          };
        }
        // The one-position-per-idea-per-account guard: no prior position for this idea.
        if (text.includes("trade_idea_id = $2")) return { rows: [] };
        if (text.includes("FROM paper_trades")) return { rows: [OPEN_TRADE_ROW] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await new PostgresPaperTradeRepository(database).openManualOption({
      accountId: "account-1",
      instrumentId: "instrument-1",
      quantity: 75,
      fillPrice: 212.95,
      openedAt: new Date("2026-08-31T09:25:00.000Z"),
      entryFees: 30.7,
      entrySlippage: 0,
      notes: "test",
      stopLossOverride: 203.17,
      targetPriceOverride: 226.52,
    });

    /*
     * The close reads the entry fee from `fee_breakdown->'entry'->>'total'` under a COALESCE, so a
     * breakdown written without that key would silently drop the entry fee from every P&L rather
     * than fail. This asserts the open always writes it.
     */
    const tradeInsert = captured.find((statement) => statement.text.includes("INSERT INTO paper_trades"));
    expect(tradeInsert?.text).toContain("fee_breakdown");
    const breakdown = captured
      .flatMap((statement) => statement.params)
      .filter((param): param is string => typeof param === "string" && param.includes("\"entry\""))
      .map((param) => JSON.parse(param) as { entry?: { total?: number } });
    expect(breakdown.length).toBeGreaterThan(0);
    for (const value of breakdown) {
      expect(value.entry?.total).toBe(30.7);
    }
  });

  it("zeroes remaining_quantity and writes a slice and a close event on both paths", async () => {
    for (const captured of [await runFullClose(), await runFinalSlice()]) {
      /*
       * The five artifacts a close leaves behind. Trade 951a0ecb has none of them, which is how a
       * hand-written UPDATE was told apart from a code path; a close path that stopped writing any
       * one of them would make that distinction unreliable.
       */
      expect(closingUpdate(captured).text).toContain("remaining_quantity = 0");
      expect(closingUpdate(captured).text).toContain("fee_breakdown");
      expect(sliceInsert(captured)).toBeDefined();
      expect(captured.some((statement) =>
        statement.text.includes("INSERT INTO paper_trade_events"))).toBe(true);
    }
  });
});
