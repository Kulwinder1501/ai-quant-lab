/**
 * Live Tripwire Measurement CLI (Gate Step 6)
 *
 * Measures alert frequency distribution across active watchlist stocks over the first
 * 20 trading days of the live soak period.
 *
 * Pre-registered Threshold:
 * - Budget Target: Median <= 3.0, p95 <= 8.0 alerts per stock-month.
 * - Live Tripwire: p95 > 8.0 alerts per stock-month over 20 trading days triggers rule recalibration.
 */

import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  computeTripwireMetrics,
  type StockAlertCount,
} from "../../modules/equity-research/domain/tripwire-metrics.js";

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
    // 1. Determine trading days in scope
    let tradingDates: string[] = [];

    if (fromDate && toDate) {
      const datesRes = await pool.query<{ d: string }>(
        `SELECT DISTINCT bar_date::text AS d
         FROM equity_research.price_bar
         WHERE bar_date >= $1::date AND bar_date <= $2::date
         ORDER BY d ASC`,
        [fromDate, toDate],
      );
      tradingDates = datesRes.rows.map((r) => r.d);
    } else if (fromDate) {
      const datesRes = await pool.query<{ d: string }>(
        `SELECT DISTINCT bar_date::text AS d
         FROM equity_research.price_bar
         WHERE bar_date >= $1::date
         ORDER BY d ASC
         LIMIT $2`,
        [fromDate, tradingDays],
      );
      tradingDates = datesRes.rows.map((r) => r.d);
    } else {
      // Default: Find the earliest evaluated dates in equity_research.alert, or latest price bars
      const alertDatesRes = await pool.query<{ d: string }>(
        `SELECT DISTINCT evaluated_date::text AS d
         FROM equity_research.alert
         ORDER BY d ASC
         LIMIT $1`,
        [tradingDays],
      );
      if (alertDatesRes.rows.length > 0) {
        tradingDates = alertDatesRes.rows.map((r) => r.d);
      } else {
        const barDatesRes = await pool.query<{ d: string }>(
          `SELECT DISTINCT bar_date::text AS d
           FROM equity_research.price_bar
           ORDER BY d DESC
           LIMIT $1`,
          [tradingDays],
        );
        tradingDates = barDatesRes.rows.map((r) => r.d).reverse();
      }
    }

    // 2. Fetch active watchlist stocks
    let stockQuery = `SELECT id, symbol, display_name FROM equity_research.watchlist_stock WHERE active = true`;
    const stockParams: unknown[] = [];
    if (symbol) {
      stockParams.push(symbol);
      stockQuery += ` AND symbol = $1`;
    }
    stockQuery += ` ORDER BY symbol ASC`;

    const stocksRes = await pool.query<{ id: string; symbol: string; display_name: string }>(
      stockQuery,
      stockParams,
    );
    const activeStocks = stocksRes.rows;

    // 3. Count alerts per stock within the selected trading window
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

    // 4. Compute tripwire metrics
    const effectiveTradingDays = tradingDates.length > 0 ? tradingDates.length : tradingDays;
    const metrics = computeTripwireMetrics(stockCounts, effectiveTradingDays);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            evaluatedWindow: {
              startDate: tradingDates[0] ?? null,
              endDate: tradingDates[tradingDates.length - 1] ?? null,
              tradingDaysCount: effectiveTradingDays,
            },
            ...metrics,
            stocks: stockCounts,
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
      `Trading Days Window:      ${effectiveTradingDays} days (${tradingDates[0] ?? "N/A"} to ${tradingDates[tradingDates.length - 1] ?? "N/A"})`,
    );
    console.log(`Active Stocks Audited:    ${metrics.sampleSize}`);
    console.log(`Scaling Factor to Month:  ${metrics.scalingFactor}x`);
    console.log("------------------------------------------------------------");
    console.log(`Median Alerts / Month:    ${metrics.median.toFixed(2)}  (Target: <= 3.0)`);
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

    if (stockCounts.length > 0 && stockCounts.length <= 25) {
      console.log("Stock Breakdown:");
      for (const s of stockCounts) {
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

main().catch((err: unknown) => {
  console.error("Tripwire measurement failed:", err);
  process.exitCode = 1;
});
