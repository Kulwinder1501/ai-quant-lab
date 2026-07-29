import type { Pool } from "pg";
import type { OffshoreDerivative } from "../../../modules/market-data/domain/offshore-derivative.js";

export class PostgresOffshoreDerivativeRepository {
  constructor(private readonly database: Pool) {}

  async upsert(derivative: OffshoreDerivative): Promise<void> {
    await this.database.query(`
      INSERT INTO offshore_derivatives (
        instrument_id,
        date,
        close_price
      ) VALUES ($1, $2, $3)
      ON CONFLICT (instrument_id, date) DO UPDATE SET
        close_price = EXCLUDED.close_price,
        updated_at = NOW()
    `, [
      derivative.instrumentId,
      derivative.date,
      derivative.closePrice
    ]);
  }

  async findByDate(instrumentId: string, date: Date): Promise<OffshoreDerivative | null> {
    const result = await this.database.query(`
      SELECT 
        instrument_id as "instrumentId",
        date,
        close_price as "closePrice"
      FROM offshore_derivatives
      WHERE instrument_id = $1 AND date = $2
    `, [instrumentId, date]);

    if (!result.rows[0]) return null;
    return {
      instrumentId: result.rows[0].instrumentId,
      date: result.rows[0].date,
      closePrice: parseFloat(result.rows[0].closePrice),
    };
  }
}
