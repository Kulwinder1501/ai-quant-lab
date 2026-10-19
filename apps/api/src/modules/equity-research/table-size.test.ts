import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import type { Pool } from "pg";

describe("Equity Research Storage Growth & Table Size Check (Gate S9)", () => {
  let pool: Pool;

  beforeAll(() => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reports table sizes and verifies equity_research schema is well within budget (< 50 MB)", async () => {
    const query = `
      SELECT
        relname AS table_name,
        pg_total_relation_size(c.oid) AS total_bytes,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty_size
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'equity_research' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
    `;

    const res = await pool.query<{
      table_name: string;
      total_bytes: string;
      pretty_size: string;
    }>(query);

    const tableSizes = res.rows.map((r) => ({
      table: r.table_name,
      bytes: Number(r.total_bytes),
      size: r.pretty_size,
    }));

    const totalBytes = tableSizes.reduce((acc, row) => acc + row.bytes, 0);
    const totalMb = totalBytes / (1024 * 1024);

    console.info("Equity Research Table Sizes (Gate S9):", {
      tables: tableSizes,
      totalSchemaBytes: totalBytes,
      totalSchemaMb: `${totalMb.toFixed(2)} MB`,
    });

    expect(totalBytes).toBeGreaterThan(0);
    // Well below the 200 MB annual threshold
    expect(totalMb).toBeLessThan(50);
  });

  it("verifies SUZLON has daily-spaced historical bars in price_bar (Condition 1)", async () => {
    const stockRes = await pool.query<{ id: string }>(
      `SELECT id FROM equity_research.watchlist_stock WHERE symbol = 'SUZLON' AND exchange = 'NSE'`,
    );
    expect(stockRes.rows.length).toBe(1);
    const stockId = stockRes.rows[0].id;

    const countRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM equity_research.price_bar WHERE stock_id = $1`,
      [stockId],
    );
    // Invariant: At least 5,179 daily bars exist (will grow as daily collector runs)
    expect(Number(countRes.rows[0].count)).toBeGreaterThanOrEqual(5179);

    // Invariant: Daily spacing without abnormal gaps (> 10 calendar days)
    const gapRes = await pool.query<{ max_gap_days: number }>(
      `
      WITH dated_bars AS (
        SELECT bar_date, LAG(bar_date) OVER (ORDER BY bar_date ASC) AS prev_date
        FROM equity_research.price_bar
        WHERE stock_id = $1
      )
      SELECT COALESCE(MAX(bar_date - prev_date), 0)::int AS max_gap_days
      FROM dated_bars
      WHERE prev_date IS NOT NULL
    `,
      [stockId],
    );
    expect(gapRes.rows[0].max_gap_days).toBeLessThanOrEqual(10);
  });

  it("verifies YAHOO reliability log and source_health satisfy isolation invariants (Condition 1)", async () => {
    // Invariant: Genuine YAHOO calls exist and grow with scheduled collection
    const yahooCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM equity_research.source_call_log WHERE source = 'YAHOO'`,
    );
    expect(Number(yahooCount.rows[0].count)).toBeGreaterThanOrEqual(17);

    // Invariant: Zero non-YAHOO, non-test source records leak into source_call_log
    const testCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM equity_research.source_call_log WHERE source != 'YAHOO' AND source NOT LIKE 'TEST_%'`,
    );
    expect(Number(testCount.rows[0].count)).toBe(0);

    // Invariant: Zero non-YAHOO, non-test source records leak into source_health
    const testHealth = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM equity_research.source_health WHERE source != 'YAHOO' AND source NOT LIKE 'TEST_%'`,
    );
    expect(Number(testHealth.rows[0].count)).toBe(0);

    // Invariant: Genuine YAHOO health rows are OK and clean
    const health = await pool.query<{
      endpoint: string;
      status: string;
      consecutive_failures: number;
    }>(
      `SELECT endpoint, status, consecutive_failures FROM equity_research.source_health WHERE source = 'YAHOO'`,
    );
    expect(health.rows.length).toBe(2);
    for (const h of health.rows) {
      expect(["OK", "DEGRADED"]).toContain(h.status);
      expect(h.consecutive_failures).toBe(0);
    }

    // Invariant: Zero test/fake records exist under YAHOO source in raw_record
    const fakeRaw = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM equity_research.raw_record WHERE source = 'YAHOO' AND (symbol LIKE 'UNKNOWN%' OR symbol LIKE 'ZZZ%' OR symbol LIKE 'TEST%')`,
    );
    expect(Number(fakeRaw.rows[0].count)).toBe(0);
  });


});
