import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import type { Pool } from "pg";
import { EquityEodCollector } from "./application/equity-eod-collector.js";
import { PostgresEquityCorporateActionRepository } from "./infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquityPriceBarRepository } from "./infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquityQuoteCacheRepository } from "./infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import { PostgresEquityRawRecordRepository } from "./infrastructure/repositories/postgres-equity-raw-record-repository.js";
import { PostgresEquitySecondaryFactRepository } from "./infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import { PostgresEquitySourceHealthRepository } from "./infrastructure/repositories/postgres-equity-source-health-repository.js";
import { PostgresEquityWatchlistRepository } from "./infrastructure/repositories/postgres-equity-watchlist-repository.js";
import { YahooClient } from "./infrastructure/yahoo-client.js";

/**
 * PROVIDER-INTEGRATION test against live Yahoo Finance (Gate S13).
 * Verifies end-to-end collection for real SUZLON ticker on NSE.
 *
 * Opt-in only via RUN_LIVE_YAHOO_TESTS=true to ensure unit test runs do not make network calls
 * or wipe user data in the live database.
 */
const isLiveTestEnabled = process.env.RUN_LIVE_YAHOO_TESTS === "true";

describe.skipIf(!isLiveTestEnabled)("Live Provider Integration: SUZLON.NS collection on record (Gate S13)", () => {
  let pool: Pool;
  let watchlistRepo: PostgresEquityWatchlistRepository;
  let rawRecordRepo: PostgresEquityRawRecordRepository;
  let priceBarRepo: PostgresEquityPriceBarRepository;
  let corporateActionRepo: PostgresEquityCorporateActionRepository;
  let secondaryFactRepo: PostgresEquitySecondaryFactRepository;
  let quoteCacheRepo: PostgresEquityQuoteCacheRepository;
  let sourceHealthRepo: PostgresEquitySourceHealthRepository;
  let yahooClient: YahooClient;
  let collector: EquityEodCollector;

  let suzlonStockId: string;

  beforeAll(async () => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);
    watchlistRepo = new PostgresEquityWatchlistRepository(pool);
    rawRecordRepo = new PostgresEquityRawRecordRepository(pool);
    priceBarRepo = new PostgresEquityPriceBarRepository(pool);
    corporateActionRepo = new PostgresEquityCorporateActionRepository(pool);
    secondaryFactRepo = new PostgresEquitySecondaryFactRepository(pool);
    quoteCacheRepo = new PostgresEquityQuoteCacheRepository(pool);
    sourceHealthRepo = new PostgresEquitySourceHealthRepository(pool);

    yahooClient = new YahooClient({
      sourceHealthRepo,
      maxDailyBudget: 300,
      minIntervalMs: 1000, // 1 req/s per-host gate
    });

    collector = new EquityEodCollector(
      watchlistRepo,
      rawRecordRepo,
      priceBarRepo,
      corporateActionRepo,
      secondaryFactRepo,
      quoteCacheRepo,
      yahooClient,
    );

    // Register real SUZLON without deleting existing user data
    const stock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: "SUZLON",
      yahooSymbol: "SUZLON.NS",
      displayName: "Suzlon Energy Limited",
    });
    suzlonStockId = stock.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("performs real end-to-end collection against live Yahoo for SUZLON.NS", async () => {
    const stock = (await watchlistRepo.findById(suzlonStockId))!;
    expect(stock).toBeDefined();

    const summary = await collector.collectStock(stock);

    console.info("SUZLON Live Collection Summary:", JSON.stringify(summary, null, 2));

    expect(summary.success).toBe(true);

    // Verify stored bars
    const bars = await priceBarRepo.getBarsByStockId(suzlonStockId);
    expect(bars.length).toBeGreaterThan(10);
    const latestBar = bars[bars.length - 1];
    expect(Number(latestBar.close)).toBeGreaterThan(0);
    expect(latestBar.source).toBe("YAHOO");
    expect(latestBar.raw_record_id).toBeDefined();

    // Verify raw records
    const chartRaw = await rawRecordRepo.findLatestBySymbolAndEndpoint("SUZLON.NS", "chart");
    expect(chartRaw).toBeDefined();
    expect(chartRaw?.outcome).toBe("OK");
    expect(chartRaw?.http_status).toBe(200);

    const fundRaw = await rawRecordRepo.findLatestBySymbolAndEndpoint("SUZLON.NS", "fundamentals");
    expect(fundRaw).toBeDefined();
    expect(fundRaw?.outcome).toBe("OK");

    // Verify corporate actions
    const actions = await corporateActionRepo.getActionsByStockId(suzlonStockId);
    expect(actions.length).toBeGreaterThanOrEqual(1);

    // Verify quote cache
    const quote = await quoteCacheRepo.getQuoteByStockId(suzlonStockId);
    expect(quote).toBeDefined();
    expect(Number(quote?.last_price)).toBeGreaterThan(0);
    expect(["PREVIOUS-CLOSE", "DELAYED", "LAST-TRADED"]).toContain(quote?.label);

    // Verify source health & call log
    const health = await sourceHealthRepo.getHealth("YAHOO", "chart");
    expect(health?.status).toBe("OK");
    const logs = await sourceHealthRepo.getRecentLogs(5);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  }, 45000); // 45s timeout for live network
});
