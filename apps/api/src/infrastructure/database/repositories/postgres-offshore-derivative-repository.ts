import type { Pool } from "pg";
import type { OffshoreDerivative } from "../../../modules/market-data/domain/offshore-derivative.js";

/** See the note in postgres-institutional-flow-repository: DATE keys bind as strings. */
function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

    const row = result.rows[0];
    if (!row) return null;
    return {
      instrumentId: row.instrument_id,
      date: row.date,
      closePrice: Number.parseFloat(String(row.close_price)),
      publishedAt: row.published_at,
    };
  }
}
