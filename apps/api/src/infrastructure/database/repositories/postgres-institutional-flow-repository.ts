import type { Pool } from "pg";
import type { InstitutionalFlow } from "../../../modules/market-data/domain/institutional-flow.js";
import { fromDateColumn, toDateKey } from "../date-column.js";

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresInstitutionalFlowRepository {
  constructor(private readonly database: Pool) {}

  async upsert(flow: InstitutionalFlow): Promise<void> {
    await this.database.query(
      `
      INSERT INTO institutional_flows (
        date,
        fii_cash_net_cr,
        dii_cash_net_cr,
        fii_index_futures_net_cr,
        fii_index_options_net_cr,
        published_at,
        source,
        is_provisional
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (date) DO UPDATE SET
        fii_cash_net_cr = EXCLUDED.fii_cash_net_cr,
        dii_cash_net_cr = EXCLUDED.dii_cash_net_cr,
        fii_index_futures_net_cr = EXCLUDED.fii_index_futures_net_cr,
        fii_index_options_net_cr = EXCLUDED.fii_index_options_net_cr,
        published_at = EXCLUDED.published_at,
        source = EXCLUDED.source,
        is_provisional = EXCLUDED.is_provisional,
        updated_at = NOW()
    `,
      [
        toDateKey(flow.date),
        flow.fiiCashNetCr,
        flow.diiCashNetCr,
        flow.fiiIndexFuturesNetCr,
        flow.fiiIndexOptionsNetCr,
        flow.publishedAt,
        flow.source ?? "NSE_CURRENT_API",
        flow.isProvisional ?? true,
      ],
    );
  }

  async findByDate(date: Date): Promise<InstitutionalFlow | null> {
    const result = await this.database.query(
      `
      SELECT date, fii_cash_net_cr, dii_cash_net_cr,
             fii_index_futures_net_cr, fii_index_options_net_cr, published_at, source, is_provisional
      FROM institutional_flows
      WHERE date = $1
    `,
      [toDateKey(date)],
    );
    return toFlow(result.rows[0]);
  }

  /**
   * The most recently published print, optionally no older than `withinDays`.
   *
   * Anything running during a live session needs this rather than `findByDate`:
   * flows for session D are published only after D closes, so a same-day lookup
   * returns nothing for the entire trading day. The staleness bound stops a long
   * collector outage from presenting month-old flows as current context.
   */
  async findLatest(options: { withinDays?: number } = {}): Promise<InstitutionalFlow | null> {
    const result = await this.database.query(
      `
      SELECT date, fii_cash_net_cr, dii_cash_net_cr,
             fii_index_futures_net_cr, fii_index_options_net_cr, published_at, source, is_provisional
      FROM institutional_flows
      WHERE ($1::int IS NULL OR date >= CURRENT_DATE - $1::int)
      ORDER BY date DESC
      LIMIT 1
    `,
      [options.withinDays ?? null],
    );
    return toFlow(result.rows[0]);
  }

  /** The most recent `limit` published prints, newest first. */
  async listRecent(limit: number): Promise<InstitutionalFlow[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 250));
    const result = await this.database.query(
      `
      SELECT date, fii_cash_net_cr, dii_cash_net_cr,
             fii_index_futures_net_cr, fii_index_options_net_cr, published_at, source, is_provisional
      FROM institutional_flows
      ORDER BY date DESC
      LIMIT $1
    `,
      [bounded],
    );
    return result.rows.map((row) => toFlow(row)).filter((flow): flow is InstitutionalFlow => flow !== null);
  }
}

function toFlow(row: Record<string, unknown> | undefined): InstitutionalFlow | null {
  if (!row) return null;
  return {
    date: fromDateColumn(row.date),
    fiiCashNetCr: toNumberOrNull(row.fii_cash_net_cr),
    diiCashNetCr: toNumberOrNull(row.dii_cash_net_cr),
    fiiIndexFuturesNetCr: toNumberOrNull(row.fii_index_futures_net_cr),
    fiiIndexOptionsNetCr: toNumberOrNull(row.fii_index_options_net_cr),
    publishedAt: row.published_at as Date,
    source: String(row.source ?? "NSE_CURRENT_API"),
    isProvisional: row.is_provisional === undefined ? true : Boolean(row.is_provisional),
  };
}
