import type { DatabasePool } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresPaperTradeRepository,
  TradeIdeaAlreadyTakenError,
  TradeIdeaUnavailableError,
} from "./postgres-paper-trade-repository.js";

/**
 * One idea, two accounts.
 *
 * The gate admitted `PROPOSED` only until 2026-08-18, which made one idea one position globally
 * rather than per account. Both bots run `momentum-scalp-index`, so whichever was iterated first
 * consumed every shared signal and the other's sample of that strategy was exactly the ideas the
 * first had declined. These assert the two halves of the fix: a second *account* may act on a taken
 * idea, and the same account may not take it twice.
 */

const OPENED_AT = new Date("2026-08-18T05:00:00.000Z");

function ideaRow(expiresAt: Date | null = null) {
  return {
    id: "idea-1", instrument_id: "instrument-1", side: "LONG",
    entry_price: "100", stop_loss: "90", target_price: "110",
    expires_at: expiresAt, lot_size: 75,
  };
}

function tradeRow() {
  return {
    id: "trade-1", account_id: "account-1", trade_idea_id: "idea-1",
    instrument_id: "instrument-1", timeframe: "5m", side: "LONG", status: "OPEN",
    quantity: "75", remaining_quantity: "75", entry_price: "100", stop_loss: "90",
    stop_loss_effective_at: OPENED_AT, target_price: "110", opened_at: OPENED_AT,
    closed_at: null, exit_price: null, exit_reason: null, realized_pnl: null,
    fees: "20", fee_breakdown: {}, slippage: "0", notes: "shared idea",
    option_strike: null, option_expiry: null, option_type: null,
    underlying_symbol: null, underlying_entry_price: null, entry_iv: null,
    regime_observation_id: null,
  };
}

function harness(options: {
  /** Rows the idea lookup returns. Empty means expired, rejected, or gone. */
  ideaRows?: unknown[];
  /** Whether this account already holds a position from the idea. */
  accountAlreadyHolds?: boolean;
}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push(text.replace(/\s+/g, " ").trim());
      parameters.push(values ?? []);
      if (text.includes("FROM paper_accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{
          id: "account-1", name: "AutoBot-Sniper", opening_balance: "1000000",
          currency: "INR", is_active: true, daily_trade_cap: null,
        }] };
      }
      if (text.includes("FROM trade_ideas") && text.includes("FOR UPDATE")) {
        return { rows: options.ideaRows ?? [ideaRow()] };
      }
      // Must precede the generic paper_trades branch: both read that table.
      if (text.includes("AND trade_idea_id = $2")) {
        return { rows: options.accountAlreadyHolds ? [{ id: "existing-trade" }] : [] };
      }
      if (text.includes("AS available_capital")) return { rows: [{ available_capital: "1000000" }] };
      if (text.includes("INSERT INTO paper_trades")) return { rows: [{ id: "trade-1" }] };
      if (text.includes("UPDATE trade_ideas SET status = 'ACCEPTED'")) return { rows: [{ id: "idea-1" }] };
      if (text.includes("FROM paper_trades")) return { rows: [tradeRow()] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const database = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
  return { statements, parameters, repository: new PostgresPaperTradeRepository(database) };
}

const OPEN_INPUT = {
  accountId: "account-1",
  tradeIdeaId: "idea-1",
  fillPrice: 100,
  quantity: 75,
  openedAt: OPENED_AT,
  entryFees: 20,
  entrySlippage: 0,
  notes: "shared idea",
};

describe("one idea, two accounts", () => {
  it("admits an idea another account has already accepted", async () => {
    const { statements, repository } = harness({});
    await repository.openFromTradeIdea(OPEN_INPUT);

    const gate = statements.find((statement) => statement.includes("FROM trade_ideas")
      && statement.includes("FOR UPDATE"));
    // Asserted on the predicate because a stub cannot show which rows the database would return.
    // Scoped to PROPOSED, the second account got an empty result and this whole path never ran.
    expect(gate).toContain("status IN ('PROPOSED', 'ACCEPTED')");
    expect(statements.some((statement) => statement.includes("INSERT INTO paper_trades"))).toBe(true);
  });

  it("marks the idea accepted idempotently, so the second account is not rolled back", async () => {
    // Scoped to PROPOSED this UPDATE returned no row for the second account and threw *after* the
    // INSERT had run, discarding a legitimate position at the last statement of the transaction.
    const { statements, repository } = harness({});
    await repository.openFromTradeIdea(OPEN_INPUT);

    const accept = statements.find((statement) => statement.includes("UPDATE trade_ideas SET status = 'ACCEPTED'"));
    expect(accept).toContain("status IN ('PROPOSED', 'ACCEPTED')");
    expect(statements).toContain("COMMIT");
  });

  it("refuses the same account a second position from one idea", async () => {
    // The bot re-reads the same completed bar every cycle and the generator returns the same idea
    // row, so this fires routinely. Admitting ACCEPTED removed the accidental guard the status gate
    // was providing, and `paper_trades_one_per_idea_per_account_idx` would otherwise surface it as a
    // raw constraint violation -- which reads as a fault rather than a repeat.
    const { statements, repository } = harness({ accountAlreadyHolds: true });

    await expect(repository.openFromTradeIdea(OPEN_INPUT))
      .rejects.toThrow(TradeIdeaAlreadyTakenError);
    expect(statements.some((statement) => statement.includes("INSERT INTO paper_trades"))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("scopes the per-account check to both the account and the idea", async () => {
    const { statements, parameters, repository } = harness({});
    await repository.openFromTradeIdea(OPEN_INPUT);

    const index = statements.findIndex((statement) => statement.includes("AND trade_idea_id = $2"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(statements[index]).toContain("account_id = $1");
    // Keyed on the account, or one account's position would block every other account -- which is
    // the bug being fixed, reintroduced one layer down.
    expect(parameters[index]).toEqual(["account-1", "idea-1"]);
  });

  it("still refuses an idea that is expired, rejected, or gone", async () => {
    // Only the "already taken" meaning was removed from the gate. An unusable idea is still unusable.
    const { repository } = harness({ ideaRows: [] });

    await expect(repository.openFromTradeIdea(OPEN_INPUT))
      .rejects.toThrow(TradeIdeaUnavailableError);
  });

  it("does not relabel an accepted idea as expired", async () => {
    // An idea that produced a position must not be recorded as one nobody acted on: the trade
    // pointing at it would contradict its own idea. The EXPIRED write stays scoped to PROPOSED.
    const { statements, repository } = harness({
      ideaRows: [ideaRow(new Date(OPENED_AT.getTime() - 1))],
    });

    await expect(repository.openFromTradeIdea(OPEN_INPUT)).rejects.toThrow(/expired/i);
    const expire = statements.find((statement) => statement.includes("SET status = 'EXPIRED'"));
    expect(expire).toContain("status = 'PROPOSED'");
    expect(expire).not.toContain("ACCEPTED");
  });

  it("checks capacity before consulting the idea at all", async () => {
    // Ordering matters for the account lock: the per-account duplicate check is only race-safe
    // because the account row is already held FOR UPDATE by the capacity gate above it.
    const { statements, repository } = harness({});
    await repository.openFromTradeIdea(OPEN_INPUT);

    const accountLock = statements.findIndex((statement) => statement.includes("FROM paper_accounts")
      && statement.includes("FOR UPDATE"));
    const duplicateCheck = statements.findIndex((statement) => statement.includes("AND trade_idea_id = $2"));
    expect(accountLock).toBeGreaterThanOrEqual(0);
    expect(duplicateCheck).toBeGreaterThan(accountLock);
  });
});
