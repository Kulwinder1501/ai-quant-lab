import type { Pool } from "pg";
import type { SecondaryFactRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export interface SecondaryFactInput {
  stockId: string;
  item: string;
  periodType: "ANNUAL" | "QUARTERLY";
  periodEnd: string; // YYYY-MM-DD
  value: number;
  currency?: string;
  basis?: string;
  rawRecordId?: string | null;
}

export class PostgresEquitySecondaryFactRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async saveFacts(facts: SecondaryFactInput[]): Promise<{ inserted: number; unchanged: number }> {
    let inserted = 0;
    let unchanged = 0;

    for (const fact of facts) {
      // Find the latest stored fact for (stock_id, item, period_type, period_end)
      const latest = await this.db.query<SecondaryFactRecord>(
        `
        SELECT *
        FROM equity_research.secondary_fact
        WHERE stock_id = $1 AND item = $2 AND period_type = $3 AND period_end = $4
        ORDER BY first_seen_at DESC
        LIMIT 1
        `,
        [fact.stockId, fact.item, fact.periodType, fact.periodEnd],
      );

      if (latest.rows.length === 0) {
        // No prior row: insert new row
        await this.db.query(
          `
          INSERT INTO equity_research.secondary_fact (
            stock_id, item, period_type, period_end, value, currency, basis, raw_record_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            fact.stockId,
            fact.item,
            fact.periodType,
            fact.periodEnd,
            fact.value,
            fact.currency ?? "INR",
            fact.basis ?? "UNKNOWN",
            fact.rawRecordId ?? null,
          ],
        );
        inserted++;
      } else {
        const currentVal = Number(latest.rows[0].value);
        if (Math.abs(currentVal - fact.value) > 0.0001) {
          // Changed value: restatement! Insert a new row so history of restatements accumulates (Gate S4)
          await this.db.query(
            `
            INSERT INTO equity_research.secondary_fact (
              stock_id, item, period_type, period_end, value, currency, basis, raw_record_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              fact.stockId,
              fact.item,
              fact.periodType,
              fact.periodEnd,
              fact.value,
              fact.currency ?? "INR",
              fact.basis ?? "UNKNOWN",
              fact.rawRecordId ?? null,
            ],
          );
          inserted++;
        } else {
          unchanged++;
        }
      }
    }

    return { inserted, unchanged };
  }

  async getFactsByStockId(stockId: string): Promise<SecondaryFactRecord[]> {
    const result = await this.db.query<SecondaryFactRecord>(
      `
      SELECT id, stock_id, item, period_type, period_end::text AS period_end, value, currency, basis, raw_record_id, first_seen_at
      FROM equity_research.secondary_fact
      WHERE stock_id = $1
      ORDER BY period_end DESC, item ASC, first_seen_at DESC
      `,
      [stockId],
    );
    return result.rows;
  }

  async deleteDerivedRows(stockId: string): Promise<void> {
    await this.db.query(`DELETE FROM equity_research.secondary_fact WHERE stock_id = $1`, [stockId]);
  }
}
