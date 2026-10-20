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
  firstSeenAt?: Date | string;
}

export class PostgresEquityCorporateActionRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async saveActions(actions: CorporateActionInput[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const action of actions) {
      const firstSeen = action.firstSeenAt ? new Date(action.firstSeenAt) : null;
      const result = await this.db.query(
        `
        INSERT INTO equity_research.corporate_action (
          stock_id, ex_date, kind, value, source, raw_record_id, first_seen_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
        ON CONFLICT (stock_id, ex_date, kind) DO NOTHING
        `,
        [
          action.stockId,
          action.exDate,
          action.kind,
          action.value,
          action.source ?? "YAHOO",
          action.rawRecordId ?? null,
          firstSeen,
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

  /**
   * Checks if a SPLIT corporate action was effective on the given evaluation date.
   * Hard rule: Use ex_date alone. Never check first_seen_at, as historical splits on
   * newly added stocks must not fire split alerts.
   * If priorBarDate is provided, also checks whether a split was effective in the gap
   * between priorBarDate and evaluationDate (e.g. over a weekend or holiday).
   */
  async hasSplitForDate(
    stockId: string,
    evaluationDate: string,
    priorBarDate?: string,
  ): Promise<boolean> {
    if (priorBarDate) {
      const result = await this.db.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM equity_research.corporate_action
          WHERE stock_id = $1
            AND kind = 'SPLIT'
            AND ex_date > $2::date
            AND ex_date <= $3::date
        ) AS exists
        `,
        [stockId, priorBarDate, evaluationDate],
      );
      return Boolean(result.rows[0]?.exists);
    }

    const result = await this.db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM equity_research.corporate_action
        WHERE stock_id = $1
          AND kind = 'SPLIT'
          AND ex_date = $2::date
      ) AS exists
      `,
      [stockId, evaluationDate],
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Fetches corporate actions (SPLIT / DIVIDEND) whose ex_date falls in (startDate, endDate].
   */
  async getActionsInWindow(
    stockId: string,
    startDate: string,
    endDate: string,
  ): Promise<CorporateActionRecord[]> {
    const result = await this.db.query<CorporateActionRecord>(
      `
      SELECT id, stock_id, ex_date::text AS ex_date, kind, value, source, raw_record_id, first_seen_at
      FROM equity_research.corporate_action
      WHERE stock_id = $1
        AND ex_date > $2::date
        AND ex_date <= $3::date
      ORDER BY ex_date ASC, kind ASC
      `,
      [stockId, startDate, endDate],
    );
    return result.rows;
  }

  /**
   * Fetches corporate actions (SPLIT / DIVIDEND) whose ex_date equals the given date.
   */
  async getActionsForDate(
    stockId: string,
    date: string,
  ): Promise<CorporateActionRecord[]> {
    const result = await this.db.query<CorporateActionRecord>(
      `
      SELECT id, stock_id, ex_date::text AS ex_date, kind, value, source, raw_record_id, first_seen_at
      FROM equity_research.corporate_action
      WHERE stock_id = $1
        AND ex_date = $2::date
      ORDER BY kind ASC
      `,
      [stockId, date],
    );
    return result.rows;
  }
}

