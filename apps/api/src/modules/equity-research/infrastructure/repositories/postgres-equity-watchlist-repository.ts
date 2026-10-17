import type { Pool } from "pg";
import type { EquityExchange, WatchlistStockRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export class PostgresEquityWatchlistRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async addStock(params: {
    exchange: EquityExchange;
    symbol: string;
    yahooSymbol: string;
    displayName?: string | null;
    currency?: string;
    note?: string | null;
  }): Promise<WatchlistStockRecord> {
    const result = await this.db.query<WatchlistStockRecord>(
      `
      INSERT INTO equity_research.watchlist_stock (
        exchange, symbol, yahoo_symbol, display_name, currency, note, active
      )
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      ON CONFLICT (exchange, symbol) DO UPDATE
        SET active = TRUE,
            yahoo_symbol = EXCLUDED.yahoo_symbol,
            display_name = COALESCE(EXCLUDED.display_name, equity_research.watchlist_stock.display_name),
            removed_at = NULL
      RETURNING *
      `,
      [
        params.exchange,
        params.symbol,
        params.yahooSymbol,
        params.displayName ?? null,
        params.currency ?? "INR",
        params.note ?? null,
      ],
    );
    return result.rows[0];
  }

  async findActiveStocks(): Promise<WatchlistStockRecord[]> {
    const result = await this.db.query<WatchlistStockRecord>(
      `
      SELECT *
      FROM equity_research.watchlist_stock
      WHERE active = TRUE
      ORDER BY symbol ASC
      `,
    );
    return result.rows;
  }

  async findBySymbol(exchange: EquityExchange, symbol: string): Promise<WatchlistStockRecord | null> {
    const result = await this.db.query<WatchlistStockRecord>(
      `
      SELECT *
      FROM equity_research.watchlist_stock
      WHERE exchange = $1 AND symbol = $2
      `,
      [exchange, symbol],
    );
    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<WatchlistStockRecord | null> {
    const result = await this.db.query<WatchlistStockRecord>(
      `
      SELECT *
      FROM equity_research.watchlist_stock
      WHERE id = $1
      `,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async removeStock(id: string): Promise<boolean> {
    const result = await this.db.query(
      `
      UPDATE equity_research.watchlist_stock
      SET active = FALSE,
          removed_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND active = TRUE
      `,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countActive(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM equity_research.watchlist_stock
      WHERE active = TRUE
      `,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async setRebackfillNeeded(id: string, needed: boolean): Promise<void> {
    await this.db.query(
      `
      UPDATE equity_research.watchlist_stock
      SET rebackfill_needed = $2
      WHERE id = $1
      `,
      [id, needed],
    );
  }

  async setRebackfillStatus(id: string, needed: boolean, seriesVersion: number): Promise<void> {
    await this.db.query(
      `
      UPDATE equity_research.watchlist_stock
      SET rebackfill_needed = $2,
          series_version = $3
      WHERE id = $1
      `,
      [id, needed, seriesVersion],
    );
  }
}
