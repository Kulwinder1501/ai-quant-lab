import type { Pool } from "pg";
import type { AlertStatus, AlertWithState } from "../../domain/types.js";
import type {
  AlertKind,
  AlertPayload,
  AlertSeverity,
  HistoricalAlertRef,
} from "../../domain/alert-rules.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export interface AlertInput {
  stockId: string;
  kind: AlertKind;
  levelKey?: string | null;
  evaluatedDate: string; // YYYY-MM-DD
  severity: AlertSeverity;
  title: string;
  payload: AlertPayload;
}

export class PostgresEquityAlertRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  /**
   * Persists evaluated alerts with idempotency (Gate E1).
   * Deduplicates by UNIQUE (stock_id, kind, coalesce(level_key, ''), evaluated_date).
   * For every newly inserted alert row, inserts an initial row into alert_state with status 'NEW'.
   */
  async saveAlerts(
    alerts: AlertInput[],
  ): Promise<{ inserted: number; skipped: number; insertedIds: string[] }> {
    if (!alerts || alerts.length === 0) {
      return { inserted: 0, skipped: 0, insertedIds: [] };
    }

    const insertedIds: string[] = [];

    // Chunks of 100 alerts
    const BATCH_SIZE = 100;
    for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
      const chunk = alerts.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const a = chunk[j];
        const offset = j * 7;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
        );
        values.push(
          a.stockId,
          a.kind,
          a.levelKey ?? null,
          a.evaluatedDate,
          a.severity,
          a.title,
          JSON.stringify(a.payload),
        );
      }

      const res = await this.db.query<{ id: string }>(
        `
        INSERT INTO equity_research.alert (
          stock_id, kind, level_key, evaluated_date, severity, title, payload_json
        )
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (stock_id, kind, (COALESCE(level_key, '')), evaluated_date) DO NOTHING
        RETURNING id
        `,
        values,
      );

      for (const row of res.rows) {
        insertedIds.push(row.id);
      }
    }

    // Insert alert_state for newly created alerts
    if (insertedIds.length > 0) {
      for (let i = 0; i < insertedIds.length; i += BATCH_SIZE) {
        const chunk = insertedIds.slice(i, i + BATCH_SIZE);
        const placeholders = chunk.map((_, idx) => `($${idx + 1}, 'NEW')`).join(", ");
        await this.db.query(
          `
          INSERT INTO equity_research.alert_state (alert_id, status)
          VALUES ${placeholders}
          ON CONFLICT (alert_id) DO NOTHING
          `,
          chunk,
        );
      }
    }

    return {
      inserted: insertedIds.length,
      skipped: alerts.length - insertedIds.length,
      insertedIds,
    };
  }

  /**
   * Fetches recent alerts for a stock prior to asOfDate.
   * Hard requirement (Gate E16): MUST include the latest DATA_HEALTH alert regardless of age,
   * so health state transitions (UNHEALTHY_ENTER -> UNHEALTHY_REPEAT -> RECOVERED) work deterministically.
   */
  async getRecentAlertsForStock(
    stockId: string,
    options?: { asOfDate?: string; lookbackCalendarDays?: number },
  ): Promise<HistoricalAlertRef[]> {
    const asOfDate = options?.asOfDate ?? new Date().toISOString().split("T")[0];
    const lookbackDays = options?.lookbackCalendarDays ?? 30;

    const query = `
      WITH recent AS (
        SELECT kind, level_key, evaluated_date::text AS evaluated_date, payload_json, created_at
        FROM equity_research.alert
        WHERE stock_id = $1
          AND evaluated_date < $2::date
          AND evaluated_date >= ($2::date - ($3 || ' days')::interval)
      ),
      latest_health AS (
        SELECT kind, level_key, evaluated_date::text AS evaluated_date, payload_json, created_at
        FROM equity_research.alert
        WHERE stock_id = $1
          AND kind = 'DATA_HEALTH'
          AND evaluated_date < $2::date
        ORDER BY evaluated_date DESC, created_at DESC
        LIMIT 1
      )
      SELECT kind, level_key, evaluated_date, payload_json
      FROM (
        SELECT * FROM recent
        UNION
        SELECT * FROM latest_health
      ) combined
      ORDER BY evaluated_date ASC, created_at ASC
    `;

    const result = await this.db.query<{
      kind: string;
      level_key: string | null;
      evaluated_date: string;
      payload_json: unknown;
    }>(query, [stockId, asOfDate, lookbackDays]);

    return result.rows.map((row) => ({
      kind: row.kind as AlertKind,
      levelKey: row.level_key,
      evaluatedDate: row.evaluated_date.split("T")[0],
      payload:
        typeof row.payload_json === "string"
          ? JSON.parse(row.payload_json)
          : (row.payload_json as AlertPayload),
    }));
  }

  /**
   * Queries alerts joined with their state and watchlist stock metadata.
   */
  async getAlerts(filter?: {
    stockId?: string;
    status?: AlertStatus;
    evaluatedDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<AlertWithState[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.stockId) {
      values.push(filter.stockId);
      conditions.push(`a.stock_id = $${values.length}`);
    }

    if (filter?.status) {
      values.push(filter.status);
      conditions.push(`s.status = $${values.length}`);
    }

    if (filter?.evaluatedDate) {
      values.push(filter.evaluatedDate);
      conditions.push(`a.evaluated_date = $${values.length}::date`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 100;
    values.push(limit);
    const limitClause = `LIMIT $${values.length}`;

    let offsetClause = "";
    if (filter?.offset) {
      values.push(filter.offset);
      offsetClause = `OFFSET $${values.length}`;
    }

    const query = `
      SELECT
        a.id,
        a.stock_id,
        a.kind,
        a.level_key,
        a.evaluated_date::text AS evaluated_date,
        a.severity,
        a.title,
        a.payload_json,
        a.created_at,
        COALESCE(s.status, 'NEW') AS status,
        COALESCE(s.updated_at, a.created_at) AS state_updated_at,
        w.symbol,
        w.display_name
      FROM equity_research.alert a
      LEFT JOIN equity_research.alert_state s ON a.id = s.alert_id
      LEFT JOIN equity_research.watchlist_stock w ON a.stock_id = w.id
      ${whereClause}
      ORDER BY a.evaluated_date DESC, a.created_at DESC
      ${limitClause}
      ${offsetClause}
    `;

    const result = await this.db.query<{
      id: string;
      stock_id: string;
      kind: string;
      level_key: string | null;
      evaluated_date: string;
      severity: "INFO" | "NOTICE";
      title: string;
      payload_json: unknown;
      created_at: Date;
      status: AlertStatus;
      state_updated_at: Date;
      symbol: string;
      display_name: string | null;
    }>(query, values);

    return result.rows.map((r) => ({
      id: r.id,
      stock_id: r.stock_id,
      kind: r.kind,
      level_key: r.level_key,
      evaluated_date: r.evaluated_date.split("T")[0],
      severity: r.severity,
      title: r.title,
      payload_json:
        typeof r.payload_json === "string"
          ? JSON.parse(r.payload_json)
          : (r.payload_json as Record<string, unknown>),
      created_at: r.created_at,
      status: r.status,
      state_updated_at: r.state_updated_at,
      symbol: r.symbol,
      display_name: r.display_name,
    }));
  }

  /**
   * Updates or upserts alert status (NEW, SEEN, DISMISSED).
   */
  async updateAlertState(alertId: string, status: AlertStatus): Promise<boolean> {
    const result = await this.db.query<{ alert_id: string }>(
      `
      INSERT INTO equity_research.alert_state (alert_id, status, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (alert_id) DO UPDATE
        SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP
      RETURNING alert_id
      `,
      [alertId, status],
    );

    return result.rows.length > 0;
  }

  /**
   * Deletes all alerts and alert states for a stock (used in isolated tests).
   */
  async deleteAlertsForStock(stockId: string): Promise<void> {
    await this.db.query(`DELETE FROM equity_research.alert WHERE stock_id = $1`, [stockId]);
  }
}
