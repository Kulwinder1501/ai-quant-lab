import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "dotenv/config";
import { loadEnvironment } from "../../../../config/environment.js";
import { createDatabasePool } from "../../../../infrastructure/database/database.js";
import type { Pool } from "pg";
import { PostgresEquityWatchlistRepository } from "./postgres-equity-watchlist-repository.js";
import { PostgresEquityPriceBarRepository } from "./postgres-equity-price-bar-repository.js";
import { PostgresEquityCorporateActionRepository } from "./postgres-equity-corporate-action-repository.js";
import { PostgresEquitySecondaryFactRepository } from "./postgres-equity-secondary-fact-repository.js";
import { PostgresEquityRawRecordRepository } from "./postgres-equity-raw-record-repository.js";
import { PostgresEquitySourceHealthRepository } from "./postgres-equity-source-health-repository.js";
import { PostgresEquityQuoteCacheRepository } from "./postgres-equity-quote-cache-repository.js";
import { parseChartRawRecord } from "../../application/parsers.js";

describe("Postgres Equity Repositories Integration (Gates S1, S2, S3, S4)", () => {
  let pool: Pool;
  let watchlistRepo: PostgresEquityWatchlistRepository;
  let priceBarRepo: PostgresEquityPriceBarRepository;
  let corporateActionRepo: PostgresEquityCorporateActionRepository;
  let secondaryFactRepo: PostgresEquitySecondaryFactRepository;
  let rawRecordRepo: PostgresEquityRawRecordRepository;
  let sourceHealthRepo: PostgresEquitySourceHealthRepository;
  let quoteCacheRepo: PostgresEquityQuoteCacheRepository;

  const TEST_NSE_SYMBOL = "TESTSUZLON";
  const TEST_SOURCE = "TEST_REPO_SOURCE";

  beforeAll(async () => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);
    watchlistRepo = new PostgresEquityWatchlistRepository(pool);
    priceBarRepo = new PostgresEquityPriceBarRepository(pool);
    corporateActionRepo = new PostgresEquityCorporateActionRepository(pool);
    secondaryFactRepo = new PostgresEquitySecondaryFactRepository(pool);
    rawRecordRepo = new PostgresEquityRawRecordRepository(pool);
    sourceHealthRepo = new PostgresEquitySourceHealthRepository(pool);
    quoteCacheRepo = new PostgresEquityQuoteCacheRepository(pool);

    await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE symbol = $1`, [TEST_NSE_SYMBOL]);
    await pool.query(`DELETE FROM equity_research.raw_record WHERE symbol LIKE $1`, [`${TEST_NSE_SYMBOL}%`]);
    await pool.query(`DELETE FROM equity_research.source_call_log WHERE source = $1`, [TEST_SOURCE]);
    await pool.query(`DELETE FROM equity_research.source_health WHERE source = $1`, [TEST_SOURCE]);
  });


  afterAll(async () => {
    // Cleanup test data from equity_research so tests never pollute real Yahoo reliability logs
    try {
      await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE symbol = $1`, [TEST_NSE_SYMBOL]);
      await pool.query(`DELETE FROM equity_research.raw_record WHERE symbol LIKE $1`, [`${TEST_NSE_SYMBOL}%`]);
      await pool.query(`DELETE FROM equity_research.source_call_log WHERE source = $1`, [TEST_SOURCE]);
      await pool.query(`DELETE FROM equity_research.source_health WHERE source = $1`, [TEST_SOURCE]);
    } finally {
      await pool.end();
    }
  });


  it("handles watchlist addition, duplicates and BSE/NSE separation (Gate S1)", async () => {
    // Add NSE stock
    const nseStock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_NSE_SYMBOL,
      yahooSymbol: `${TEST_NSE_SYMBOL}.NS`,
      displayName: "Test Suzlon NSE",
    });
    expect(nseStock.id).toBeDefined();
    expect(nseStock.exchange).toBe("NSE");

    // Add again: upserts cleanly without duplicate key error
    const duplicateNse = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_NSE_SYMBOL,
      yahooSymbol: `${TEST_NSE_SYMBOL}.NS`,
    });
    expect(duplicateNse.id).toBe(nseStock.id);

    // Add BSE listing: must be a separate row, NOT merged! (Gate S1)
    const bseStock = await watchlistRepo.addStock({
      exchange: "BSE",
      symbol: TEST_NSE_SYMBOL,
      yahooSymbol: `${TEST_NSE_SYMBOL}.BO`,
      displayName: "Test Suzlon BSE",
    });
    expect(bseStock.id).toBeDefined();
    expect(bseStock.id).not.toBe(nseStock.id);
    expect(bseStock.exchange).toBe("BSE");
  });

  it("lands raw record first, links price bars, and allows re-parsing from raw (Gate S2)", async () => {
    const nseStock = (await watchlistRepo.findBySymbol("NSE", TEST_NSE_SYMBOL))!;

    const rawData = {
      chart: {
        result: [
          {
            meta: { symbol: `${TEST_NSE_SYMBOL}.NS`, regularMarketPrice: 42.5 },
            timestamp: [1791949500],
            indicators: {
              quote: [
                {
                  open: [40.0],
                  high: [43.0],
                  low: [39.0],
                  close: [42.5],
                  volume: [500000],
                },
              ],
            },
            events: {
              dividends: {
                "1138732200": { amount: 1.25, date: 1138938300 },
              },
            },
          },
        ],
      },
    };

    // 1. Land raw record
    const raw = await rawRecordRepo.saveRawRecord({
      source: TEST_SOURCE,
      endpoint: "chart",
      symbol: `${TEST_NSE_SYMBOL}.NS`,
      httpStatus: 200,
      bodySha256: "test-hash-123",
      body: rawData,
      outcome: "OK",
    });

    expect(raw.id).toBeDefined();

    // 2. Parse and save bars
    const parsed = parseChartRawRecord(raw, nseStock.id);
    const barSave1 = await priceBarRepo.saveBars(parsed.priceBars);
    expect(barSave1.inserted).toBe(1);

    // Verify row points to raw record
    const storedBars = await priceBarRepo.getBarsByStockId(nseStock.id);
    expect(storedBars.length).toBe(1);
    expect(storedBars[0].raw_record_id).toBe(raw.id);
    expect(Number(storedBars[0].close)).toBe(42.5);

    // Save corporate action
    const actionSave = await corporateActionRepo.saveActions(parsed.corporateActions);
    expect(actionSave.inserted).toBe(1);

    // 3. Delete derived rows and reprocess from stored raw (Gate S2)
    await priceBarRepo.deleteDerivedRows(nseStock.id);
    await corporateActionRepo.deleteDerivedRows(nseStock.id);
    expect(await priceBarRepo.hasBars(nseStock.id)).toBe(false);

    // Replay from raw
    const replayedRaw = (await rawRecordRepo.findById(raw.id))!;
    const replayedParsed = parseChartRawRecord(replayedRaw, nseStock.id);
    await priceBarRepo.saveBars(replayedParsed.priceBars);
    await corporateActionRepo.saveActions(replayedParsed.corporateActions);

    const replayedBars = await priceBarRepo.getBarsByStockId(nseStock.id);
    expect(replayedBars.length).toBe(1);
    expect(Number(replayedBars[0].close)).toBe(42.5);
  });

  it("handles price bar revisions without overwriting original bar (Gate S4)", async () => {
    const nseStock = (await watchlistRepo.findBySymbol("NSE", TEST_NSE_SYMBOL))!;

    // Initial bar for date 2026-10-15
    const initialBar = {
      stockId: nseStock.id,
      barDate: "2026-10-15",
      open: 40.0,
      high: 42.0,
      low: 39.5,
      close: 41.0,
      volume: 100000,
    };
    await priceBarRepo.saveBars([initialBar]);

    // Same date arrives later with restated close 41.5
    const restatedBar = {
      ...initialBar,
      close: 41.5,
      volume: 105000,
    };
    const res = await priceBarRepo.saveBars([restatedBar]);

    expect(res.inserted).toBe(0);
    expect(res.revisions).toBe(1);

    // Stored price series in price_bar is updated to maintain continuous, unbroken series
    const bars = await priceBarRepo.getBarsByStockId(nseStock.id);
    const targetBar = bars.find((b) => b.bar_date.startsWith("2026-10-15"));
    expect(Number(targetBar?.close)).toBe(41.5);

    // Original bar survives in price_bar_revision (Gate S4)
    const revisions = await priceBarRepo.getRevisionsByStockId(nseStock.id);
    const targetRevision = revisions.find((r) => r.bar_date.startsWith("2026-10-15"));
    expect(targetRevision).toBeDefined();
    expect(targetRevision?.previous_values.close).toBe(41.0);
    expect(targetRevision?.new_values.close).toBe(41.5);

    // Repeated runs with identical values deduplicate and do NOT add duplicate revisions
    const repeatRes = await priceBarRepo.saveBars([restatedBar]);
    expect(repeatRes.revisions).toBe(0);
    expect(repeatRes.unchanged).toBe(1);

    const revisionsAfterRepeat = await priceBarRepo.getRevisionsByStockId(nseStock.id);
    const dateRevisions = revisionsAfterRepeat.filter((r) => r.bar_date.startsWith("2026-10-15"));
    expect(dateRevisions.length).toBe(1);
  });

  it("accumulates restatements in secondary_fact without overwriting (Gate S4)", async () => {
    const nseStock = (await watchlistRepo.findBySymbol("NSE", TEST_NSE_SYMBOL))!;

    // Initial fact
    await secondaryFactRepo.saveFacts([
      {
        stockId: nseStock.id,
        item: "annualTotalRevenue",
        periodType: "ANNUAL",
        periodEnd: "2025-03-31",
        value: 100000000,
      },
    ]);

    // Restated value for the same period
    await secondaryFactRepo.saveFacts([
      {
        stockId: nseStock.id,
        item: "annualTotalRevenue",
        periodType: "ANNUAL",
        periodEnd: "2025-03-31",
        value: 105000000, // restated
      },
    ]);

    const storedFacts = await secondaryFactRepo.getFactsByStockId(nseStock.id);
    const revFacts = storedFacts.filter((f) => f.item === "annualTotalRevenue");

    // Both rows survive!
    expect(revFacts.length).toBe(2);
    expect(Number(revFacts[0].value)).toBe(105000000); // latest
    expect(Number(revFacts[1].value)).toBe(100000000); // original
  });

  it("stores quote cache and records source health and call logs", async () => {
    const nseStock = (await watchlistRepo.findBySymbol("NSE", TEST_NSE_SYMBOL))!;

    await quoteCacheRepo.upsertQuote({
      stockId: nseStock.id,
      lastPrice: 42.15,
      marketTime: new Date("2026-10-16T10:00:00Z"),
      label: "PREVIOUS-CLOSE",
      latencySeconds: 15,
    });

    const cached = await quoteCacheRepo.getQuoteByStockId(nseStock.id);
    expect(cached).toBeDefined();
    expect(Number(cached?.last_price)).toBe(42.15);
    expect(cached?.label).toBe("PREVIOUS-CLOSE");

    await sourceHealthRepo.recordCallLog({
      source: TEST_SOURCE,
      endpoint: "chart",
      status: 200,
      durationMs: 120,
    });

    await sourceHealthRepo.updateHealth({
      source: TEST_SOURCE,
      endpoint: "chart",
      success: true,
      dateKey: "2026-10-17",
      budgetToday: 300,
    });

    const health = await sourceHealthRepo.getHealth(TEST_SOURCE, "chart");
    expect(health).toBeDefined();
    expect(health?.status).toBe("OK");
    expect(health?.calls_today).toBeGreaterThanOrEqual(1);
  });

  it("appends warnings to raw record without mutating existing fields (Condition 3)", async () => {
    const raw = await rawRecordRepo.saveRawRecord({
      source: TEST_SOURCE,
      endpoint: "chart",
      symbol: "TESTSUZLON.NS",
      httpStatus: 200,
      bodySha256: "testwarninghash",
      body: { test: true },
      outcome: "OK",
      warnings: ["initial warning"],
    });

    await rawRecordRepo.appendWarnings(raw.id, [
      "Skipped bar at index 10 (2020-05-01): missing close price.",
      "Skipped bar at index 12 (2020-05-05): missing close price.",
    ]);

    const updated = await rawRecordRepo.findById(raw.id);
    expect(updated).toBeDefined();
    const warnings = updated?.warnings as string[];
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toBe("initial warning");
    expect(warnings[1]).toContain("2020-05-01");
    expect(warnings[2]).toContain("2020-05-05");
  });

  it("detects and captures volume revisions in price_bar_revision (Condition 4)", async () => {
    const nseStock = (await watchlistRepo.findBySymbol("NSE", TEST_NSE_SYMBOL))!;

    const barDate = "2026-10-16";
    // First save bar with initial volume
    await priceBarRepo.saveBars([
      {
        stockId: nseStock.id,
        barDate,
        open: 50.0,
        high: 52.0,
        low: 49.0,
        close: 51.0,
        volume: 61930540,
        source: "YAHOO",
      },
    ]);

    // Second run: volume revised after the fact by Yahoo (62200077)
    const result = await priceBarRepo.saveBars([
      {
        stockId: nseStock.id,
        barDate,
        open: 50.0,
        high: 52.0,
        low: 49.0,
        close: 51.0,
        volume: 62200077, // revised
        source: "YAHOO",
      },
    ]);

    expect(result.inserted).toBe(0);
    expect(result.revisions).toBe(1);
    expect(result.unchanged).toBe(0);

    // Verify revision row recorded previous and new volume
    const revisions = await priceBarRepo.getRevisionsByStockId(nseStock.id);
    const volumeRev = revisions.find((r) => r.bar_date === barDate && r.new_values.volume === 62200077);
    expect(volumeRev).toBeDefined();
    expect(volumeRev?.previous_values.volume).toBe(61930540);
    expect(volumeRev?.new_values.volume).toBe(62200077);

    // price_bar is updated to restated volume while old volume survives in price_bar_revision
    const storedBars = await priceBarRepo.getBarsByStockId(nseStock.id);
    const stored = storedBars.find((b) => b.bar_date === barDate);
    expect(stored).toBeDefined();
    expect(Number(stored?.volume)).toBe(62200077);
  });
});
