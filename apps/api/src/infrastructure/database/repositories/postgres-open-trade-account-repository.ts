import type { DatabaseQueryable } from "../database.js";
import type { OpenTradeAccountReader } from "../../../modules/paper-trading/application/sweep-open-paper-trade-exits.js";

/**
 * Accounts currently holding an open trade.
 *
 * Derived from the positions rather than from the bot's roster. `run-paper-trading-bot.ts`
 * declares its accounts but calls `main()` at module scope, so importing that list would run the
 * whole bot inside whatever process asked; reading the data avoids that and also covers an
 * account the bot does not own, which is what an operator's manually opened position is.
 */
export class PostgresOpenTradeAccountRepository implements OpenTradeAccountReader {
  constructor(private readonly database: DatabaseQueryable) {}

  async listAccountIdsWithOpenTrades(): Promise<string[]> {
    const result = await this.database.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM paper_trades WHERE status = 'OPEN'`,
    );
    return result.rows.map((row) => String(row.account_id));
  }
}
