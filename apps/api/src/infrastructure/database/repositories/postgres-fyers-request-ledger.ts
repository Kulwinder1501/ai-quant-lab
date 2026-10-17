import type { DatabasePool } from "../database.js";
import { setFyersRequestPersister } from "../../../modules/market-data/domain/fyers-request-counter.js";

export class PostgresFyersRequestLedger {
  constructor(private readonly pool: DatabasePool) {}

  async recordRequests(dateKey: string, endpoint: string, count: number): Promise<void> {
    if (count <= 0) return;
    await this.pool.query(
      `INSERT INTO fyers_daily_request_ledger (date_key, endpoint, request_count, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (date_key, endpoint)
       DO UPDATE SET request_count = fyers_daily_request_ledger.request_count + EXCLUDED.request_count,
                     updated_at = CURRENT_TIMESTAMP;`,
      [dateKey, endpoint, count],
    );
  }

  async recordBatch(dateKey: string, counts: Record<string, number>): Promise<void> {
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    if (entries.length === 0) return;
    for (const [endpoint, count] of entries) {
      await this.recordRequests(dateKey, endpoint, count);
    }
  }

  async getDailyTotal(dateKey: string): Promise<number> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(request_count), 0)::text as total
       FROM fyers_daily_request_ledger
       WHERE date_key = $1;`,
      [dateKey],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Connects this ledger instance to the process's global fyersRequestCounter.
   * Any Fyers REST request executed by this process will be recorded to this database ledger
   * on periodic flush or shutdown.
   */
  attachToGlobalCounter(): void {
    setFyersRequestPersister((counts, dateKey) => {
      void this.recordBatch(dateKey, counts).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          message: "Failed to persist Fyers request counts to ledger",
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    });
  }
}

