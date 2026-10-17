import type { Pool } from "pg";
import type { SourceCallLogRecord, SourceHealthRecord, StockHealthStatus } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export class PostgresEquitySourceHealthRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async recordCallLog(log: {
    source: string;
    endpoint: string;
    status: number;
    durationMs: number;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.db.query(
      `
      INSERT INTO equity_research.source_call_log (
        source, endpoint, status, duration_ms, error_message
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [log.source, log.endpoint, log.status, log.durationMs, log.errorMessage ?? null],
    );
  }

  async updateHealth(params: {
    source: string;
    endpoint: string;
    success: boolean;
    dateKey: string;
    budgetToday?: number;
    errorMessage?: string | null;
    isRateLimited?: boolean;
  }): Promise<void> {
    const budget = params.budgetToday ?? 300;

    // Check existing health row
    const existing = await this.db.query<SourceHealthRecord>(
      `
      SELECT *
      FROM equity_research.source_health
      WHERE source = $1 AND endpoint = $2
      `,
      [params.source, params.endpoint],
    );

    const now = new Date();

    if (existing.rows.length === 0) {
      const callsToday = 1;
      const consecutiveFailures = params.success ? 0 : 1;
      let status: StockHealthStatus = params.success ? "OK" : "DEGRADED";
      if (params.isRateLimited) status = "RATE_LIMITED";

      await this.db.query(
        `
        INSERT INTO equity_research.source_health (
          source, endpoint, last_success_at, last_failure_at, status, consecutive_failures, calls_today, budget_today, date_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          params.source,
          params.endpoint,
          params.success ? now : null,
          params.success ? null : now,
          status,
          consecutiveFailures,
          callsToday,
          budget,
          params.dateKey,
        ],
      );
    } else {
      const row = existing.rows[0];
      const isSameDay = row.date_key === params.dateKey;
      const callsToday = isSameDay ? row.calls_today + 1 : 1;
      const consecutiveFailures = params.success ? 0 : row.consecutive_failures + 1;

      let status: StockHealthStatus = "OK";
      if (params.isRateLimited) {
        status = "RATE_LIMITED";
      } else if (!params.success) {
        status = consecutiveFailures >= 3 ? "UNAVAILABLE" : "DEGRADED";
      }

      await this.db.query(
        `
        UPDATE equity_research.source_health
        SET last_success_at = CASE WHEN $3 THEN $5 ELSE last_success_at END,
            last_failure_at = CASE WHEN NOT $3 THEN $5 ELSE last_failure_at END,
            status = $4,
            consecutive_failures = $6,
            calls_today = $7,
            budget_today = $8,
            date_key = $9
        WHERE source = $1 AND endpoint = $2
        `,
        [
          params.source,
          params.endpoint,
          params.success,
          status,
          now,
          consecutiveFailures,
          callsToday,
          budget,
          params.dateKey,
        ],
      );
    }
  }

  async setStatus(source: string, endpoint: string, status: StockHealthStatus): Promise<void> {
    await this.db.query(
      `
      UPDATE equity_research.source_health
      SET status = $3
      WHERE source = $1 AND endpoint = $2
      `,
      [source, endpoint, status],
    );
  }

  async getHealth(source: string, endpoint: string): Promise<SourceHealthRecord | null> {
    const result = await this.db.query<SourceHealthRecord>(
      `
      SELECT *
      FROM equity_research.source_health
      WHERE source = $1 AND endpoint = $2
      `,
      [source, endpoint],
    );
    return result.rows[0] ?? null;
  }

  async getAllHealth(): Promise<SourceHealthRecord[]> {
    const result = await this.db.query<SourceHealthRecord>(
      `
      SELECT *
      FROM equity_research.source_health
      ORDER BY source, endpoint
      `,
    );
    return result.rows;
  }

  async getTotalCallsToday(source: string, dateKey: string): Promise<number> {
    const result = await this.db.query<{ total: string }>(
      `
      SELECT COALESCE(SUM(calls_today), 0)::text AS total
      FROM equity_research.source_health
      WHERE source = $1 AND date_key = $2
      `,
      [source, dateKey],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async getRecentLogs(limit = 50): Promise<SourceCallLogRecord[]> {
    const result = await this.db.query<SourceCallLogRecord>(
      `
      SELECT *
      FROM equity_research.source_call_log
      ORDER BY time DESC
      LIMIT $1
      `,
      [limit],
    );
    return result.rows;
  }
}
