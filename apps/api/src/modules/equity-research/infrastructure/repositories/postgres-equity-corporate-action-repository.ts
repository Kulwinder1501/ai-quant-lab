import type { Pool } from "pg";
import type { CorporateActionRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export interface CorporateActionInput {
  stockId: string;
  exDate: string; // YYYY-MM-DD
  kind: "DIVIDEND" | "SPLIT";
  value: number;
  source?: string;
  rawRecordId?: string | null;
}

export class PostgresEquityCorporateActionRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async saveActions(actions: CorporateActionInput[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const action of actions) {
      const result = await this.db.query(
        `
        INSERT INTO equity_research.corporate_action (
          stock_id, ex_date, kind, value, source, raw_record_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (stock_id, ex_date, kind) DO NOTHING
        `,
        [
          action.stockId,
          action.exDate,
          action.kind,
          action.value,
          action.source ?? "YAHOO",
          action.rawRecordId ?? null,
        ],
      );

      if ((result.rowCount ?? 0) > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    return { inserted, skipped };
  }

  async getActionsByStockId(stockId: string): Promise<CorporateActionRecord[]> {
    const result = await this.db.query<CorporateActionRecord>(
      `
      SELECT id, stock_id, ex_date::text AS ex_date, kind, value, source, raw_record_id, first_seen_at
      FROM equity_research.corporate_action
      WHERE stock_id = $1
      ORDER BY ex_date ASC
      `,
      [stockId],
    );
    return result.rows;
  }

  async deleteDerivedRows(stockId: string): Promise<void> {
    await this.db.query(`DELETE FROM equity_research.corporate_action WHERE stock_id = $1`, [stockId]);
  }
}
