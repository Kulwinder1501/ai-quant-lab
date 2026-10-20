import type { Pool } from "pg";
import { MANUAL_EVENT_KINDS, type EventFlagKind, type EventFlagOrigin, type EventFlagRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export class EventAlreadySupersededError extends Error {
  constructor(message: string, public readonly newerRevisionId: string) {
    super(message);
    this.name = "EventAlreadySupersededError";
  }
}

export interface DetectedEventInput {
  stockId: string;
  kind: EventFlagKind;
  eventDate: string; // YYYY-MM-DD
  headline: string;
  detail?: Record<string, unknown>;
  sourceUrl?: string | null;
}

export interface ManualEventInput {
  stockId: string;
  kind: EventFlagKind;
  eventDate: string; // YYYY-MM-DD
  headline: string;
  sourceUrl: string; // Must be https (Gate E8)
  detail?: Record<string, unknown>;
  supersedesId?: string | null; // Revision pointer (Gate E9)
}

export interface EventFlagQueryFilter {
  stockId?: string;
  symbol?: string;
  origin?: EventFlagOrigin;
  kind?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  includeHistory?: boolean;
  limit?: number;
  offset?: number;
}

export class PostgresEquityEventFlagRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  /**
   * Persists a detected event flag idempotently.
   * Unique constraint per (stock_id, kind, event_date, detail key) prevents duplicate flags on re-runs.
   */
  async saveDetectedEvent(
    event: DetectedEventInput,
  ): Promise<{ id?: string; inserted: boolean }> {
    const detail = event.detail ?? {};
    const key = (detail.key as string) ?? "";
    const detailWithKey = { ...detail, key };

    const result = await this.db.query<{ id: string }>(
      `
      INSERT INTO equity_research.event_flag (
        stock_id, kind, origin, event_date, headline, source_url, detail_json
      )
      VALUES ($1, $2, 'DETECTED', $3, $4, $5, $6)
      ON CONFLICT (stock_id, kind, event_date, (COALESCE(detail_json->>'key', '')))
      WHERE origin = 'DETECTED'
      DO NOTHING
      RETURNING id
      `,
      [
        event.stockId,
        event.kind,
        event.eventDate,
        event.headline,
        event.sourceUrl ?? null,
        JSON.stringify(detailWithKey),
      ],
    );

    if (result.rows.length > 0) {
      return { id: result.rows[0].id, inserted: true };
    }
    return { inserted: false };
  }

  /**
   * Persists a manual, owner-entered event flag.
   * Gate E8: Rejects without a valid https URL at both the API and database levels.
   * Gate E9: Immutability: An edit creates a new revision with supersedes_id pointing to the prior row;
   *          the old row remains strictly untouched.
   */
  async saveManualEvent(event: ManualEventInput): Promise<EventFlagRecord> {
    // Gate: kind must be one of the plan's manual event kinds
    if (!MANUAL_EVENT_KINDS.includes(event.kind as any)) {
      throw new Error(
        `Invalid event kind '${event.kind}'. Manual events must use one of: ${MANUAL_EVENT_KINDS.join(", ")}`,
      );
    }

    const trimmedUrl = event.sourceUrl ? event.sourceUrl.trim() : "";
    if (
      !trimmedUrl ||
      !trimmedUrl.toLowerCase().startsWith("https://") ||
      trimmedUrl.length <= 8
    ) {
      throw new Error(
        "Manual event requires a valid https source link (Gate E8)",
      );
    }

    if (event.supersedesId) {
      const priorCheck = await this.db.query<{ id: string }>(
        `SELECT id FROM equity_research.event_flag WHERE id = $1`,
        [event.supersedesId],
      );
      if (priorCheck.rows.length === 0) {
        throw new Error(
          `Superseded event ${event.supersedesId} not found (Gate E9)`,
        );
      }

      // Fork protection: check if event has already been superseded (points to head of chain)
      const branchCheck = await this.db.query<{ id: string }>(
        `
        WITH RECURSIVE chain AS (
          SELECT id, supersedes_id, created_at
          FROM equity_research.event_flag
          WHERE supersedes_id = $1
          UNION ALL
          SELECT e.id, e.supersedes_id, e.created_at
          FROM equity_research.event_flag e
          JOIN chain c ON e.supersedes_id = c.id
        )
        SELECT id FROM chain
        WHERE NOT EXISTS (
          SELECT 1 FROM equity_research.event_flag sub WHERE sub.supersedes_id = chain.id
        )
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [event.supersedesId],
      );
      if (branchCheck.rows.length > 0) {
        throw new EventAlreadySupersededError(
          `Event ${event.supersedesId} has already been superseded by ${branchCheck.rows[0].id}`,
          branchCheck.rows[0].id,
        );
      }
    }

    const detail = event.detail ?? {};

    const result = await this.db.query<{
      id: string;
      stock_id: string;
      kind: string;
      origin: EventFlagOrigin;
      event_date: string;
      headline: string;
      source_url: string | null;
      detail_json: unknown;
      supersedes_id: string | null;
      created_at: Date;
    }>(
      `
      INSERT INTO equity_research.event_flag (
        stock_id, kind, origin, event_date, headline, source_url, detail_json, supersedes_id
      )
      VALUES ($1, $2, 'MANUAL', $3, $4, $5, $6, $7)
      RETURNING
        id,
        stock_id,
        kind,
        origin,
        event_date::text AS event_date,
        headline,
        source_url,
        detail_json,
        supersedes_id,
        created_at
      `,
      [
        event.stockId,
        event.kind,
        event.eventDate,
        event.headline,
        trimmedUrl,
        JSON.stringify(detail),
        event.supersedesId ?? null,
      ],
    );

    const r = result.rows[0];
    return {
      id: r.id,
      stock_id: r.stock_id,
      kind: r.kind,
      origin: r.origin,
      event_date: r.event_date.split("T")[0],
      headline: r.headline,
      source_url: r.source_url,
      detail_json:
        typeof r.detail_json === "string"
          ? JSON.parse(r.detail_json)
          : (r.detail_json as Record<string, unknown>),
      supersedes_id: r.supersedes_id,
      created_at: r.created_at,
    };
  }

  /**
   * Fetches event flags for a stock in reverse chronological order.
   * By default, hides superseded revisions (only returns latest/current).
   */
  async getEventsByStockId(
    stockId: string,
    options?: { limit?: number; offset?: number; origin?: EventFlagOrigin; kind?: string; includeHistory?: boolean },
  ): Promise<EventFlagRecord[]> {
    const conditions: string[] = ["stock_id = $1"];
    const values: unknown[] = [stockId];

    if (!options?.includeHistory) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM equity_research.event_flag sub WHERE sub.supersedes_id = equity_research.event_flag.id
      )`);
    }

    if (options?.origin) {
      values.push(options.origin);
      conditions.push(`origin = $${values.length}`);
    }

    if (options?.kind) {
      values.push(options.kind);
      conditions.push(`kind = $${values.length}`);
    }

    const limit = options?.limit ?? 100;
    values.push(limit);
    const limitClause = `LIMIT $${values.length}`;

    let offsetClause = "";
    if (options?.offset) {
      values.push(options.offset);
      offsetClause = `OFFSET $${values.length}`;
    }

    const result = await this.db.query<{
      id: string;
      stock_id: string;
      kind: string;
      origin: EventFlagOrigin;
      event_date: string;
      headline: string;
      source_url: string | null;
      detail_json: unknown;
      supersedes_id: string | null;
      created_at: Date;
    }>(
      `
      SELECT
        id,
        stock_id,
        kind,
        origin,
        event_date::text AS event_date,
        headline,
        source_url,
        detail_json,
        supersedes_id,
        created_at
      FROM equity_research.event_flag
      WHERE ${conditions.join(" AND ")}
      ORDER BY event_date DESC, created_at DESC
      ${limitClause}
      ${offsetClause}
      `,
      values,
    );

    return result.rows.map((r) => ({
      id: r.id,
      stock_id: r.stock_id,
      kind: r.kind,
      origin: r.origin,
      event_date: r.event_date.split("T")[0],
      headline: r.headline,
      source_url: r.source_url,
      detail_json:
        typeof r.detail_json === "string"
          ? JSON.parse(r.detail_json)
          : (r.detail_json as Record<string, unknown>),
      supersedes_id: r.supersedes_id,
      created_at: r.created_at,
    }));
  }

  /**
   * Queries event flags with optional filtering across stocks.
   * By default, returns only current revisions (hides superseded rows).
   */
  async getEvents(filter?: EventFlagQueryFilter): Promise<EventFlagRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (!filter?.includeHistory) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM equity_research.event_flag sub WHERE sub.supersedes_id = e.id
      )`);
    }

    if (filter?.stockId) {
      values.push(filter.stockId);
      conditions.push(`e.stock_id = $${values.length}`);
    }

    if (filter?.symbol) {
      values.push(filter.symbol.trim().toUpperCase());
      conditions.push(`w.symbol = $${values.length}`);
    }

    if (filter?.origin) {
      values.push(filter.origin);
      conditions.push(`e.origin = $${values.length}`);
    }

    if (filter?.kind) {
      values.push(filter.kind);
      conditions.push(`e.kind = $${values.length}`);
    }

    if (filter?.from) {
      values.push(filter.from);
      conditions.push(`e.event_date >= $${values.length}::date`);
    }

    if (filter?.to) {
      values.push(filter.to);
      conditions.push(`e.event_date <= $${values.length}::date`);
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

    const result = await this.db.query<{
      id: string;
      stock_id: string;
      kind: string;
      origin: EventFlagOrigin;
      event_date: string;
      headline: string;
      source_url: string | null;
      detail_json: unknown;
      supersedes_id: string | null;
      created_at: Date;
      symbol?: string;
    }>(
      `
      SELECT
        e.id,
        e.stock_id,
        e.kind,
        e.origin,
        e.event_date::text AS event_date,
        e.headline,
        e.source_url,
        e.detail_json,
        e.supersedes_id,
        e.created_at,
        w.symbol
      FROM equity_research.event_flag e
      LEFT JOIN equity_research.watchlist_stock w ON e.stock_id = w.id
      ${whereClause}
      ORDER BY e.event_date DESC, e.created_at DESC
      ${limitClause}
      ${offsetClause}
      `,
      values,
    );

    return result.rows.map((r) => ({
      id: r.id,
      stock_id: r.stock_id,
      kind: r.kind,
      origin: r.origin,
      event_date: r.event_date.split("T")[0],
      headline: r.headline,
      source_url: r.source_url,
      detail_json:
        typeof r.detail_json === "string"
          ? JSON.parse(r.detail_json)
          : (r.detail_json as Record<string, unknown>),
      supersedes_id: r.supersedes_id,
      created_at: r.created_at,
      symbol: r.symbol,
    }));
  }

  /**
   * Fetches a specific event flag by ID.
   */
  async getEventById(id: string): Promise<EventFlagRecord | null> {
    const result = await this.db.query<{
      id: string;
      stock_id: string;
      kind: string;
      origin: EventFlagOrigin;
      event_date: string;
      headline: string;
      source_url: string | null;
      detail_json: unknown;
      supersedes_id: string | null;
      created_at: Date;
    }>(
      `
      SELECT
        id,
        stock_id,
        kind,
        origin,
        event_date::text AS event_date,
        headline,
        source_url,
        detail_json,
        supersedes_id,
        created_at
      FROM equity_research.event_flag
      WHERE id = $1
      `,
      [id],
    );

    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      stock_id: r.stock_id,
      kind: r.kind,
      origin: r.origin,
      event_date: r.event_date.split("T")[0],
      headline: r.headline,
      source_url: r.source_url,
      detail_json:
        typeof r.detail_json === "string"
          ? JSON.parse(r.detail_json)
          : (r.detail_json as Record<string, unknown>),
      supersedes_id: r.supersedes_id,
      created_at: r.created_at,
    };
  }

  /**
   * Fetches the latest active head of the revision chain that supersedes this event (if any).
   */
  async getNewerRevision(id: string): Promise<EventFlagRecord | null> {
    const result = await this.db.query<{ id: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT id, supersedes_id, created_at
        FROM equity_research.event_flag
        WHERE supersedes_id = $1
        UNION ALL
        SELECT e.id, e.supersedes_id, e.created_at
        FROM equity_research.event_flag e
        JOIN chain c ON e.supersedes_id = c.id
      )
      SELECT id FROM chain
      WHERE NOT EXISTS (
        SELECT 1 FROM equity_research.event_flag sub WHERE sub.supersedes_id = chain.id
      )
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id],
    );
    if (result.rows.length === 0) return null;
    return this.getEventById(result.rows[0].id);
  }

  /**
   * Deletes events for a stock (used in test isolation).
   */
  async deleteEventsForStock(stockId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM equity_research.event_flag WHERE stock_id = $1`,
      [stockId],
    );
  }
}
