import type { DatabaseQueryable } from "../database.js";
import { fromDateColumn } from "../date-column.js";

export interface DailyIndexClose {
  date: Date;
  close: number;
  receivedAt: Date;
  source: string;
}

export class PostgresMarketContextReader {
  constructor(private readonly database: DatabaseQueryable) {}

  async listDailyCloses(symbol: string, limit: number): Promise<DailyIndexClose[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 250));
    const result = await this.database.query(`
      SELECT c.open_time::date AS date, c.close, c.received_at, c.source
      FROM candles c
      INNER JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1
        AND c.timeframe = '1d'
        AND c.is_complete = TRUE
        AND c.close > 0
      ORDER BY c.open_time DESC
      LIMIT $2
    `, [symbol, bounded]);
    return result.rows.flatMap((row) => {
      const close = Number(row.close);
      if (!Number.isFinite(close) || close <= 0) return [];
      return [{
        date: fromDateColumn(row.date),
        close,
        receivedAt: row.received_at as Date,
        source: String(row.source),
      }];
    });
  }
}
