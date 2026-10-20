/**
 * Live Tripwire Measurement CLI (Gate Step 6)
 *
 * Measures alert frequency distribution across active watchlist stocks over the first
 * 20 trading days of the live soak period.
 *
 * Pre-registered Threshold:
 * - Budget Target: Median <= 3.0, p95 <= 8.0 level alerts per stock-month.
 * - Live Tripwire: p95 > 8.0 level alerts per stock-month over 20 trading days triggers rule recalibration.
 *
 * Important Invariants:
 * 1. Trading days are counted strictly from price bars (bar dates), NEVER from alert dates.
 *    Days with zero alerts are legitimate trading days in the denominator.
 * 2. In default mode, the window starts at the earliest alert evaluation date (soak start)
 *    and takes the first 20 bar dates on or after that date from equity_research.price_bar.
 * 3. The tripwire metric evaluates LEVEL ALERTS ONLY (LEVEL_BREAK, LEVEL_ZONE_ENTER, LEVEL_APPROACH),
 *    matching the calibration protocol.
 */

import "dotenv/config";
import type { Pool } from "pg";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  computeTripwireMetrics,
  type StockAlertCount,
  type TripwireDistribution,
} from "../../modules/equity-research/domain/tripwire-metrics.js";

export interface TripwireAuditResult {
  evaluatedWindow: {
    startDate: string | null;
    endDate: string | null;
    tradingDaysCount: number;
  };
  metrics: TripwireDistribution;
  stocks: StockAlertCount[];
}

/**
 * Resolves the trading dates (bar dates) to evaluate for the tripwire audit.
 * In default mode, starts at the earliest alert evaluation date and takes the first N bar dates.
 */
export async function resolveTripwireTradingDates(
  pool: Pool,
  options?: {
    fromDate?: string;
    toDate?: string;
    tradingDays?: number;
    symbol?: string;
    stockId?: string;
  },
): Promise<string[]> {
  const tradingDays = options?.tradingDays ?? 20;

  if (options?.fromDate && options?.toDate) {
    const datesRes = await pool.query<{ d: string }>(
      `SELECT DISTINCT bar_date::text AS d
       FROM equity_research.price_bar
       WHERE bar_date >= $1::date AND bar_date <= $2::date
       ORDER BY d ASC`,
      [options.fromDate, options.toDate],
    );
    return datesRes.rows.map((r) => r.d);
  }

  if (options?.fromDate) {
    const datesRes = await pool.query<{ d: string }>(
      `SELECT DISTINCT bar_date::text AS d
       FROM equity_research.price_bar
       WHERE bar_date >= $1::date
       ORDER BY d ASC
       LIMIT $2`,
      [options.fromDate, tradingDays],
    );
    return datesRes.rows.map((r) => r.d);
  }

  // Default mode:
  // Start at the earliest alert evaluation date in equity_research.alert (the soak start date),
  // filtered by symbol/stockId if specified,
  // and take the first N trading days (bar dates) on or after that date from equity_research.price_bar.
  let soakStartQuery = `SELECT MIN(evaluated_date)::text AS soak_start FROM equity_research.alert`;
  const soakStartParams: unknown[] = [];
  if (options?.stockId) {
    soakStartQuery += ` WHERE stock_id = $1`;
    soakStartParams.push(options.stockId);
  } else if (options?.symbol) {
    soakStartQuery = `
      SELECT MIN(a.evaluated_date)::text AS soak_start
      FROM equity_research.alert a
      JOIN equity_research.watchlist_stock s ON s.id = a.stock_id
      WHERE s.symbol = $1
    `;
    soakStartParams.push(options.symbol);
  }

  const earliestAlertRes = await pool.query<{ soak_start: string | null }>(
    soakStartQuery,
    soakStartParams,
  );
  const soakStart = earliestAlertRes.rows[0]?.soak_start;

  if (soakStart) {
    const barDatesRes = await pool.query<{ d: string }>(
      `SELECT DISTINCT bar_date::text AS d
       FROM equity_research.price_bar
       WHERE bar_date >= $1::date
       ORDER BY d ASC
       LIMIT $2`,
      [soakStart, tradingDays],
    );
    return barDatesRes.rows.map((r) => r.d);
  }

  // Fallback when no alerts exist yet: take the latest N bar dates from price_bar
  const barDatesRes = await pool.query<{ d: string }>(
    `SELECT bar_date::text AS d
     FROM (
       SELECT DISTINCT bar_date
       FROM equity_research.price_bar
       ORDER BY bar_date DESC
       LIMIT $1
     ) sub
     ORDER BY bar_date ASC`,
    [tradingDays],
  );
  return barDatesRes.rows.map((r) => r.d);
}

/**
 * Audits the live tripwire metrics across active watchlist stocks.
 */
export async function auditTripwire(
  pool: Pool,
  options?: {
    tradingDays?: number;
    fromDate?: string;
    toDate?: string;
    symbol?: string;
  },
): Promise<TripwireAuditResult> {
  const tradingDays = options?.tradingDays ?? 20;
  const tradingDates = await resolveTripwireTradingDates(pool, {
    fromDate: options?.fromDate,
    toDate: options?.toDate,
    tradingDays,
    symbol: options?.symbol,
  });

  let stockQuery = `SELECT id, symbol, display_name FROM equity_research.watchlist_stock WHERE active = true`;
  const stockParams: unknown[] = [];
  if (options?.symbol) {
    stockParams.push(options.symbol);
    stockQuery += ` AND symbol = $1`;
  }
  stockQuery += ` ORDER BY symbol ASC`;

  const stocksRes = await pool.query<{ id: string; symbol: string; display_name: string }>(
    stockQuery,
    stockParams,
  );
  const activeStocks = stocksRes.rows;

  const stockCounts: StockAlertCount[] = [];

  for (const stock of activeStocks) {
    if (tradingDates.length === 0) {
      stockCounts.push({
        stockId: stock.id,
        symbol: stock.symbol,
        levelAlertsCount: 0,
        totalAlertsCount: 0,
      });
      continue;
    }

    const alertRes = await pool.query<{ level_count: string; total_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE kind IN ('LEVEL_BREAK', 'LEVEL_ZONE_ENTER', 'LEVEL_APPROACH')) AS level_count,
         COUNT(*) AS total_count
       FROM equity_research.alert
       WHERE stock_id = $1
         AND evaluated_date = ANY($2::date[])`,
      [stock.id, tradingDates],
    );

    stockCounts.push({
      stockId: stock.id,
      symbol: stock.symbol,
      levelAlertsCount: parseInt(alertRes.rows[0]?.level_count ?? "0", 10),
      totalAlertsCount: parseInt(alertRes.rows[0]?.total_count ?? "0", 10),
    });
  }

  const effectiveTradingDays = tradingDates.length > 0 ? tradingDates.length : tradingDays;
  const metrics = computeTripwireMetrics(stockCounts, effectiveTradingDays);

  return {
    evaluatedWindow: {
      startDate: tradingDates[0] ?? null,
      endDate: tradingDates[tradingDates.length - 1] ?? null,
      tradingDaysCount: effectiveTradingDays,
    },
    metrics,
    stocks: stockCounts,
  };
}

function parseArgs(args: string[]): {
  tradingDays: number;
  fromDate?: string;
  toDate?: string;
  symbol?: string;
  jsonOutput: boolean;
} {
  let tradingDays = 20;
  let fromDate: string | undefined;
  let toDate: string | undefined;
  let symbol: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--trading-days" && i + 1 < args.length) {
      tradingDays = parseInt(args[i + 1], 10);
    } else if (args[i] === "--from-date" && i + 1 < args.length) {
      fromDate = args[i + 1];
    } else if (args[i] === "--to-date" && i + 1 < args.length) {
      toDate = args[i + 1];
    } else if (args[i] === "--symbol" && i + 1 < args.length) {
      symbol = args[i + 1].toUpperCase();
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  return { tradingDays, fromDate, toDate, symbol, jsonOutput };
}

async function main(): Promise<void> {
  const { tradingDays, fromDate, toDate, symbol, jsonOutput } = parseArgs(
    process.argv.slice(2),
  );

  const env = loadEnvironment();
  const pool = createDatabasePool(env.DATABASE_URL);

  try {
    const audit = await auditTripwire(pool, { tradingDays, fromDate, toDate, symbol });
    const { evaluatedWindow, metrics, stocks } = audit;

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            evaluatedWindow,
            ...metrics,
            stocks,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Formatted Console Report
    console.log("\n============================================================");
    console.log("       EQUITY ALERTS LIVE TRIPWIRE AUDIT (Gate Step 6)      ");
    console.log("============================================================");
    console.log(
      `Trading Days Window:      ${evaluatedWindow.tradingDaysCount} bar dates (${evaluatedWindow.startDate ?? "N/A"} to ${evaluatedWindow.endDate ?? "N/A"})`,
    );
    console.log(`Active Stocks Audited:    ${metrics.sampleSize}`);
    console.log(`Scaling Factor to Month:  ${metrics.scalingFactor}x`);
    console.log("------------------------------------------------------------");
    console.log(`Median Level Alerts/Mo:   ${metrics.median.toFixed(2)}  (Target: <= 3.0)`);
    console.log(`95th Percentile / Month:  ${metrics.p95.toFixed(2)}  (Budget: <= 8.0)`);
    console.log(`Mean Alerts / Month:      ${metrics.mean.toFixed(2)}`);
    console.log(`75th Percentile:          ${metrics.p75.toFixed(2)}`);
    console.log(`90th Percentile:          ${metrics.p90.toFixed(2)}`);
    console.log(`99th Percentile:          ${metrics.p99.toFixed(2)}`);
    console.log(`Max Alerts in Window:     ${metrics.max.toFixed(2)}`);
    console.log("------------------------------------------------------------");
    console.log(`Tripwire Status:          [${metrics.status}]`);
    console.log(`Tripwire Gate Result:     ${metrics.tripwireTriggered ? "FAIL (Tighten calibration)" : "PASS (Clear)"}`);
    console.log(`Summary:                  ${metrics.message}`);
    console.log("============================================================\n");

    if (metrics.sampleSize < 20) {
      console.log("Note on sample size:");
      console.log(
        `  Watchlist has ${metrics.sampleSize} stock(s). Percentiles (p95) are descriptive and equal the maximum for tiny samples.`,
      );
      console.log("  Evaluate raw alert counts directly until the watchlist reaches 20+ stocks.\n");
    }

    if (stocks.length > 0 && stocks.length <= 25) {
      console.log("Stock Breakdown (Level Alerts Evaluated):");
      for (const s of stocks) {
        console.log(
          `  - ${s.symbol.padEnd(12)}: ${s.levelAlertsCount} level alerts (${(s.levelAlertsCount * metrics.scalingFactor).toFixed(1)}/mo), ${s.totalAlertsCount} total alerts`,
        );
      }
      console.log("");
    }
  } finally {
    await pool.end();
  }
}

// Execute main only when run directly from CLI
if (process.argv[1]?.includes("measure-equity-alerts-tripwire")) {
  main().catch((err: unknown) => {
    console.error("Tripwire measurement failed:", err);
    process.exitCode = 1;
  });
}
