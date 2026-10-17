import type { Pool } from "pg";
import type { EquityOutcome, RawRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export class PostgresEquityRawRecordRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async saveRawRecord(record: {
    source: string;
    endpoint: string;
    symbol: string;
    requestedAt?: Date;
    httpStatus: number;
    bodySha256: string;
    body: unknown;
    outcome: EquityOutcome;
    warnings?: string[];
  }): Promise<RawRecord> {
    const result = await this.db.query<RawRecord>(
      `
      INSERT INTO equity_research.raw_record (
        source, endpoint, symbol, requested_at, http_status, body_sha256, body, outcome, warnings
      )
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        record.source,
        record.endpoint,
        record.symbol,
        record.requestedAt ?? null,
        record.httpStatus,
        record.bodySha256,
        JSON.stringify(record.body),
        record.outcome,
        JSON.stringify(record.warnings ?? []),
      ],
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<RawRecord | null> {
    const result = await this.db.query<RawRecord>(
      `
      SELECT *
      FROM equity_research.raw_record
      WHERE id = $1
      `,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findLatestBySymbolAndEndpoint(symbol: string, endpoint: string): Promise<RawRecord | null> {
    const result = await this.db.query<RawRecord>(
      `
      SELECT *
      FROM equity_research.raw_record
      WHERE symbol = $1 AND endpoint = $2
      ORDER BY requested_at DESC
      LIMIT 1
      `,
      [symbol, endpoint],
    );
    return result.rows[0] ?? null;
  }

  async findBySymbol(symbol: string, limit = 20): Promise<RawRecord[]> {
    const result = await this.db.query<RawRecord>(
      `
      SELECT id, source, endpoint, symbol, requested_at, http_status, body_sha256, outcome, warnings
      FROM equity_research.raw_record
      WHERE symbol = $1 OR symbol LIKE $2
      ORDER BY requested_at DESC
      LIMIT $3
      `,
      [symbol, `${symbol}.%`, limit],
    );
    return result.rows;
  }

  async appendWarnings(id: string, warnings: string[]): Promise<void> {
    if (!warnings || warnings.length === 0) return;
    await this.db.query(
      `
      UPDATE equity_research.raw_record
      SET warnings = warnings || $2::jsonb
      WHERE id = $1
      `,
      [id, JSON.stringify(warnings)],
    );
  }
}
