import type { Pool } from "pg";
import type { PriceQuoteLabel, QuoteCacheRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export class PostgresEquityQuoteCacheRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async upsertQuote(quote: {
    stockId: string;
    lastPrice: number;
    marketTime: Date;
    fetchedAt?: Date;
    label: PriceQuoteLabel;
    latencySeconds?: number | null;
  }): Promise<void> {
    await this.db.query(
      `
      INSERT INTO equity_research.quote_cache (
        stock_id, last_price, market_time, fetched_at, label, latency_seconds
      )
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5, $6)
      ON CONFLICT (stock_id) DO UPDATE
        SET last_price = EXCLUDED.last_price,
            market_time = EXCLUDED.market_time,
            fetched_at = EXCLUDED.fetched_at,
            label = EXCLUDED.label,
            latency_seconds = EXCLUDED.latency_seconds
      `,
      [
        quote.stockId,
        quote.lastPrice,
        quote.marketTime,
        quote.fetchedAt ?? null,
        quote.label,
        quote.latencySeconds ?? null,
      ],
    );
  }

  async getQuoteByStockId(stockId: string): Promise<QuoteCacheRecord | null> {
    const result = await this.db.query<any>(
      `
      SELECT stock_id, last_price, market_time, fetched_at, label, latency_seconds
      FROM equity_research.quote_cache
      WHERE stock_id = $1
      `,
      [stockId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      stock_id: row.stock_id,
      last_price: Number(row.last_price),
      market_time: row.market_time,
      fetched_at: row.fetched_at,
      label: row.label,
      latency_seconds:
        row.latency_seconds !== null && row.latency_seconds !== undefined
          ? Math.round(Number(row.latency_seconds))
          : null,
    } as any;
  }
}
