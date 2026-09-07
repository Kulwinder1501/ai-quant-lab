import type { DatabaseQueryable } from "../database.js";
import type { ExpiredProvisionalCandleRepository } from "../../../modules/market-data/application/reconcile-expired-provisional-candles.js";

export class PostgresExpiredProvisionalCandleRepository implements ExpiredProvisionalCandleRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async deleteExpiredProvisionalCandles(closedBefore: Date): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM candles
       WHERE is_complete = FALSE
         AND close_time < $1`,
      [closedBefore],
    );
    return result.rowCount ?? 0;
  }
}
