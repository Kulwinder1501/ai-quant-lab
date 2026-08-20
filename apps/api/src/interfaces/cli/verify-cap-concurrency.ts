import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { DailyTradeCapReachedError } from "../../modules/paper-trading/domain/paper-trade-open-errors.js";

/**
 * Closes strategist verification items 7 and 9, which the unit suite structurally cannot.
 *
 *   7. Two concurrent opens on one account at its final slot: exactly one succeeds.
 *   9. Rollback on a failure inside the open transaction leaves capacity available — the account row
 *      lock releases either way.
 *
 * Both are statements about a *real race* and a *real rollback* across two live database connections.
 * A faked client can only prove the daily-cap count is read under the `FOR UPDATE` lock (the ordering
 * assertion the unit tests already make); it cannot prove that two genuinely concurrent transactions
 * resolve to exactly one winner, nor that a rolled-back transaction actually releases its lock. So this
 * runs the real `PostgresPaperTradeRepository` against the live database, with the pool handing each
 * concurrent `openFromTradeIdea` its own connection.
 *
 * ## Why the item-9 trigger is a capital rejection, and why that is faithful
 *
 * `openFromTradeIdea` wraps the whole open in one transaction and, in its catch, ROLLBACKs on every
 * error except `TradeIdeaExpiredError`. A genuine INSERT constraint violation and an insufficient-
 * capital rejection therefore take the *identical* rollback path — the account row lock, held `FOR
 * UPDATE` since the top of the transaction, releases when that transaction ends either way. The capital
 * rejection is the deterministic, schema-independent way to drive a post-lock, in-transaction failure;
 * forcing an actual INSERT constraint error would test the same ROLLBACK with a more fragile trigger.
 * The invariant verified — a failed open consumes no capacity and blocks no later open — is item 9's.
 *
 * ## Footprint
 *
 * It creates two clearly-named scratch accounts and a handful of PROPOSED trade ideas on NIFTY50, and
 * deletes every row it created before it exits (reported). Nothing it writes is meant to persist, and
 * a failed assertion still runs the cleanup.
 *
 * Usage: verify-cap-concurrency
 */

const SENTINEL = "__VERIFY_CAP__";
const LONG_ENTRY = 100;
const LONG_STOP = 90;
const LONG_TARGET = 115;

interface Check {
  readonly item: string;
  readonly description: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  const runId = `${SENTINEL}${Date.now()}`;
  const accountRepository = new PostgresPaperAccountRepository(database);
  const tradeRepository = new PostgresPaperTradeRepository(database);
  const createdAccountIds: string[] = [];
  const createdIdeaIds: string[] = [];
  const checks: Check[] = [];

  // A PROPOSED LONG idea on the given instrument, expiring a day out so it is actionable now.
  // The schema requires `reasoning` to be a JSON array and `evidence` a JSON object; neither is read on
  // the open path, so minimal well-typed values satisfy the checks without inventing content.
  async function createIdea(instrumentId: string): Promise<string> {
    const result = await database.query<{ id: string }>(`
      INSERT INTO trade_ideas (
        instrument_id, strategy_version_id, source_candle_id, side, status,
        entry_price, stop_loss, target_price, risk_reward, confidence,
        reasoning, evidence, expires_at
      ) VALUES (
        $1, NULL, NULL, 'LONG', 'PROPOSED', $2, $3, $4, 1.5, 1.0,
        $5::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 day'
      ) RETURNING id
    `, [instrumentId, LONG_ENTRY, LONG_STOP, LONG_TARGET, JSON.stringify([`${runId} verification idea`])]);
    const id = result.rows[0]!.id;
    createdIdeaIds.push(id);
    return id;
  }

  try {
    const instrumentRow = await database.query<{ id: string; lot_size: string }>(
      "SELECT id, lot_size FROM instruments WHERE symbol = $1", ["NIFTY50"],
    );
    if (!instrumentRow.rows[0]) throw new Error("NIFTY50 is not a registered instrument; cannot build fixtures.");
    const instrumentId = instrumentRow.rows[0].id;
    const lotSize = Number(instrumentRow.rows[0].lot_size);
    if (!Number.isInteger(lotSize) || lotSize <= 0) throw new Error(`NIFTY50 lot size is unusable: ${lotSize}.`);

    // ---------------------------------------------------------------------------------------------
    // Item 7 — two concurrent opens on an account whose only slot is the one they contend for.
    // ---------------------------------------------------------------------------------------------
    {
      const account = await accountRepository.create({ name: `${runId}-race`, openingBalance: lotSize * LONG_ENTRY * 1000 });
      createdAccountIds.push(account.id);
      await database.query("UPDATE paper_accounts SET daily_trade_cap = 1 WHERE id = $1", [account.id]);

      // Two *different* ideas, so the only thing that can stop the second open is the cap — not the
      // per-idea lock or the one-position-per-idea guard, which would test a different guarantee.
      const ideaA = await createIdea(instrumentId);
      const ideaB = await createIdea(instrumentId);
      const openedAt = new Date();
      const base = { accountId: account.id, quantity: lotSize, fillPrice: LONG_ENTRY, openedAt, entryFees: 0, entrySlippage: 0, notes: runId };

      const [first, second] = await Promise.allSettled([
        tradeRepository.openFromTradeIdea({ ...base, tradeIdeaId: ideaA }),
        tradeRepository.openFromTradeIdea({ ...base, tradeIdeaId: ideaB }),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === "fulfilled").length;
      const rejections = [first, second].filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
      const capRejections = rejections.filter((e) => e instanceof DailyTradeCapReachedError).length;

      const stored = await database.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM paper_trades WHERE account_id = $1", [account.id],
      );
      const storedCount = Number(stored.rows[0]!.n);

      const passed = fulfilled === 1 && capRejections === 1 && rejections.length === 1 && storedCount === 1;
      checks.push({
        item: "7",
        description: "Two concurrent opens on one account at its final slot: exactly one succeeds",
        passed,
        detail: `fulfilled=${fulfilled}, rejected=${rejections.length}, capRejections=${capRejections}, `
          + `storedTrades=${storedCount}` + (passed ? "" : ` — rejections: ${rejections.map((e) => (e as Error).message).join(" | ")}`),
      });
    }

    // ---------------------------------------------------------------------------------------------
    // Item 9 — a failure inside the open transaction rolls back, releasing the lock and leaving the
    // slot available for a subsequent open.
    // ---------------------------------------------------------------------------------------------
    {
      const account = await accountRepository.create({ name: `${runId}-rollback`, openingBalance: lotSize * LONG_ENTRY * 5 });
      createdAccountIds.push(account.id);
      await database.query("UPDATE paper_accounts SET daily_trade_cap = 2 WHERE id = $1", [account.id]);

      const failingIdea = await createIdea(instrumentId);
      const succeedingIdea = await createIdea(instrumentId);
      const openedAt = new Date();
      const base = { accountId: account.id, fillPrice: LONG_ENTRY, openedAt, entryFees: 0, entrySlippage: 0, notes: runId };

      // A quantity whose notional dwarfs the opening balance: the capital check throws *after* the
      // account row is locked FOR UPDATE and the cap gate has passed, so the whole transaction rolls
      // back. This is the representative post-lock, in-transaction failure (see the header).
      let failureRejected = false;
      let failureMessage = "";
      try {
        await tradeRepository.openFromTradeIdea({ ...base, tradeIdeaId: failingIdea, quantity: lotSize * 50 });
      } catch (error) {
        failureRejected = true;
        failureMessage = error instanceof Error ? error.message : String(error);
      }

      const afterFailure = await database.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM paper_trades WHERE account_id = $1", [account.id],
      );
      const consumedNothing = Number(afterFailure.rows[0]!.n) === 0;

      // If the failed transaction had not released its FOR UPDATE lock, this open would block until the
      // pool/statement timeout rather than return promptly. That it succeeds is the lock-release proof.
      let followUpSucceeded = false;
      let followUpMessage = "";
      try {
        await tradeRepository.openFromTradeIdea({ ...base, tradeIdeaId: succeedingIdea, quantity: lotSize });
        followUpSucceeded = true;
      } catch (error) {
        followUpMessage = error instanceof Error ? error.message : String(error);
      }

      const afterFollowUp = await database.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM paper_trades WHERE account_id = $1", [account.id],
      );
      const capacityPreserved = Number(afterFollowUp.rows[0]!.n) === 1;

      const passed = failureRejected && consumedNothing && followUpSucceeded && capacityPreserved;
      checks.push({
        item: "9",
        description: "Rollback on a failed open leaves capacity available; the account lock releases either way",
        passed,
        detail: `failureRejected=${failureRejected} ("${failureMessage}"), consumedNothing=${consumedNothing}, `
          + `followUpSucceeded=${followUpSucceeded}${followUpMessage ? ` ("${followUpMessage}")` : ""}, `
          + `capacityPreserved=${capacityPreserved}`,
      });
    }
  } finally {
    // Remove every row this run created, children first for the foreign keys. Reported, and attempted
    // even if an assertion above threw, so a scratch account never lingers in the paper-trading system.
    const cleanup: Record<string, number> = { trades: 0, ideas: 0, accounts: 0 };
    try {
      if (createdAccountIds.length > 0) {
        const t = await database.query("DELETE FROM paper_trades WHERE account_id = ANY($1::uuid[])", [createdAccountIds]);
        cleanup.trades = t.rowCount ?? 0;
      }
      if (createdIdeaIds.length > 0) {
        const i = await database.query("DELETE FROM trade_ideas WHERE id = ANY($1::uuid[])", [createdIdeaIds]);
        cleanup.ideas = i.rowCount ?? 0;
      }
      if (createdAccountIds.length > 0) {
        const a = await database.query("DELETE FROM paper_accounts WHERE id = ANY($1::uuid[])", [createdAccountIds]);
        cleanup.accounts = a.rowCount ?? 0;
      }
    } catch (cleanupError) {
      console.error("Cleanup failed — scratch rows may remain and need manual removal:", cleanupError);
    }

    const allPassed = checks.length === 2 && checks.every((c) => c.passed);
    console.info(JSON.stringify({
      level: allPassed ? "info" : "error",
      message: "Daily-cap concurrency verification complete",
      runId,
      checks,
      cleanup,
      verdict: allPassed
        ? "PASS — items 7 and 9 confirmed against the live database"
        : "FAIL — see checks",
    }, null, 2));

    await database.end();
    if (!allPassed) process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error("Daily-cap concurrency verification failed:", error);
  process.exitCode = 1;
});
