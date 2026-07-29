import type { Pool } from "pg";
import type { InstitutionalFlow } from "../../../modules/market-data/domain/institutional-flow.js";

export class PostgresInstitutionalFlowRepository {
  constructor(private readonly database: Pool) {}

  async upsert(flow: InstitutionalFlow): Promise<void> {
    await this.database.query(`
      INSERT INTO institutional_flows (
        date,
        fii_cash_net_cr,
        dii_cash_net_cr,
        fii_index_futures_net_cr,
        fii_index_options_net_cr
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (date) DO UPDATE SET
        fii_cash_net_cr = EXCLUDED.fii_cash_net_cr,
        dii_cash_net_cr = EXCLUDED.dii_cash_net_cr,
        fii_index_futures_net_cr = EXCLUDED.fii_index_futures_net_cr,
        fii_index_options_net_cr = EXCLUDED.fii_index_options_net_cr,
        updated_at = NOW()
    `, [
      flow.date,
      flow.fiiCashNetCr,
      flow.diiCashNetCr,
      flow.fiiIndexFuturesNetCr,
      flow.fiiIndexOptionsNetCr
    ]);
  }

  async findByDate(date: Date): Promise<InstitutionalFlow | null> {
    const result = await this.database.query(`
      SELECT 
        date,
        fii_cash_net_cr as "fiiCashNetCr",
        dii_cash_net_cr as "diiCashNetCr",
        fii_index_futures_net_cr as "fiiIndexFuturesNetCr",
        fii_index_options_net_cr as "fiiIndexOptionsNetCr"
      FROM institutional_flows
      WHERE date = $1
    `, [date]);

    if (!result.rows[0]) return null;
    return {
      date: result.rows[0].date,
      fiiCashNetCr: parseFloat(result.rows[0].fiiCashNetCr),
      diiCashNetCr: parseFloat(result.rows[0].diiCashNetCr),
      fiiIndexFuturesNetCr: parseFloat(result.rows[0].fiiIndexFuturesNetCr),
      fiiIndexOptionsNetCr: parseFloat(result.rows[0].fiiIndexOptionsNetCr),
    };
  }
}
