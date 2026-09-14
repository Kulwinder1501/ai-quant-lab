import type { Pool } from "pg";
import type { OffshoreDerivative } from "../../../modules/market-data/domain/offshore-derivative.js";
import { fromDateColumn, toDateKey } from "../date-column.js";

export class PostgresOffshoreDerivativeRepository {
  constructor(private readonly database: Pool) {}

  async upsert(derivative: OffshoreDerivative): Promise<void> {
    if (!Number.isFinite(derivative.closePrice) || derivative.closePrice <= 0) {
      // Also enforced by a CHECK in migration 010. Failing here gives the caller a
      // readable message instead of a constraint violation surfacing from the driver.
      throw new Error(
        `Refusing to persist a non-positive offshore close for ${derivative.instrumentId}: absent data must be an absent row, not a zero price.`,
      );
    }

    await this.database.query(
      `
      INSERT INTO offshore_derivatives (
        instrument_id,
        date,
        close_price,
        published_at
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (instrument_id, date) DO UPDATE SET
        close_price = EXCLUDED.close_price,
        published_at = EXCLUDED.published_at,
        updated_at = NOW()
    `,
      [derivative.instrumentId, toDateKey(derivative.date), derivative.closePrice, derivative.publishedAt],
    );
  }

  async findByDate(instrumentId: string, date: Date): Promise<OffshoreDerivative | null> {
    const result = await this.database.query(
      `
      SELECT instrument_id, date, close_price, published_at
      FROM offshore_derivatives
      WHERE instrument_id = $1 AND date = $2
    `,
      [instrumentId, toDateKey(date)],
    );

    return toDerivative(result.rows[0]);
  }

  /** The most recent print for an instrument, whatever session it belongs to. */
  async findLatest(instrumentId: string): Promise<OffshoreDerivative | null> {
    const result = await this.database.query(
      `
      SELECT instrument_id, date, close_price, published_at
      FROM offshore_derivatives
      WHERE instrument_id = $1
      ORDER BY date DESC
      LIMIT 1
    `,
      [instrumentId],
    );
    return toDerivative(result.rows[0]);
  }

  async listRecent(instrumentId: string, limit: number): Promise<OffshoreDerivative[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 250));
    const result = await this.database.query(`
      SELECT instrument_id, date, close_price, published_at
      FROM offshore_derivatives
      WHERE instrument_id = $1
      ORDER BY date DESC
      LIMIT $2
    `, [instrumentId, bounded]);
    return result.rows.map((row) => toDerivative(row)).filter((row): row is OffshoreDerivative => row !== null);
  }
}

function toDerivative(row: Record<string, unknown> | undefined): OffshoreDerivative | null {
  if (!row) return null;
  return {
    instrumentId: String(row.instrument_id),
    date: fromDateColumn(row.date),
    closePrice: Number.parseFloat(String(row.close_price)),
    publishedAt: row.published_at as Date,
  };
}
