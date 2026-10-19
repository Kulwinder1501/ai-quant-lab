import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "dotenv/config";
import { loadEnvironment } from "../../../../config/environment.js";
import { createDatabasePool } from "../../../../infrastructure/database/database.js";
import type { Pool } from "pg";
import { PostgresEquityWatchlistRepository } from "./postgres-equity-watchlist-repository.js";
import { PostgresEquityPriceBarRepository } from "./postgres-equity-price-bar-repository.js";
import { PostgresEquityAlertRepository } from "./postgres-equity-alert-repository.js";
import { PostgresEquityEventFlagRepository } from "./postgres-equity-event-flag-repository.js";
import { PostgresEquitySourceHealthRepository } from "./postgres-equity-source-health-repository.js";
import { EquityAlertsEvaluationService } from "../../application/equity-alerts-evaluation-service.js";
import { EQUITY_ALERT_FOOTER, EQUITY_ALERT_RULES_HASH } from "../../domain/alert-rules.js";

describe("Postgres Equity Alerts & Event Flags Integration (Gates E1, E2, E8, E9, E12, E16)", () => {
  let pool: Pool;
  let watchlistRepo: PostgresEquityWatchlistRepository;
  let priceBarRepo: PostgresEquityPriceBarRepository;
  let alertRepo: PostgresEquityAlertRepository;
  let eventFlagRepo: PostgresEquityEventFlagRepository;
  let sourceHealthRepo: PostgresEquitySourceHealthRepository;
  let evalService: EquityAlertsEvaluationService;

  const TEST_SYMBOL = "TEST_ALERTS_STOCK";
  const TEST_SOURCE = "TEST_ALERTS_SOURCE";
  let testStockId: string;

  beforeAll(async () => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);
    watchlistRepo = new PostgresEquityWatchlistRepository(pool);
    priceBarRepo = new PostgresEquityPriceBarRepository(pool);
    alertRepo = new PostgresEquityAlertRepository(pool);
    eventFlagRepo = new PostgresEquityEventFlagRepository(pool);
    sourceHealthRepo = new PostgresEquitySourceHealthRepository(pool);
    evalService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
    );

    // Clean up any stale test stock data
    const existing = await watchlistRepo.findBySymbol("NSE", TEST_SYMBOL);
    if (existing) {
      await alertRepo.deleteAlertsForStock(existing.id);
      await eventFlagRepo.deleteEventsForStock(existing.id);
      await priceBarRepo.deleteDerivedRows(existing.id);
      await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE id = $1`, [existing.id]);
    }

    const stock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_SYMBOL,
      yahooSymbol: `${TEST_SYMBOL}.NS`,
      displayName: "Test Alerts Synthetic Stock",
    });
    testStockId = stock.id;
  });

  afterAll(async () => {
    try {
      if (testStockId) {
        await alertRepo.deleteAlertsForStock(testStockId);
        await eventFlagRepo.deleteEventsForStock(testStockId);
        await priceBarRepo.deleteDerivedRows(testStockId);
        await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE id = $1`, [testStockId]);
      }
    } finally {
      await pool.end();
    }
  });

  it("Gate E1: Idempotent - evaluating the same date twice adds no rows", async () => {
    const evalDate = "2026-10-15";

    const alertsToSave = [
      {
        stockId: testStockId,
        kind: "LEVEL_APPROACH" as const,
        levelKey: "SWING_100.50",
        evaluatedDate: evalDate,
        severity: "INFO" as const,
        title: "Approaching swing support at 100.50",
        payload: {
          close: 101.2,
          evaluatedDate: evalDate,
          seriesVersion: 1,
          rulesHash: EQUITY_ALERT_RULES_HASH,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      },
      {
        stockId: testStockId,
        kind: "NEW_52W_EXTREME" as const,
        levelKey: null,
        evaluatedDate: evalDate,
        severity: "NOTICE" as const,
        title: "New 52-week high",
        payload: {
          close: 101.2,
          evaluatedDate: evalDate,
          seriesVersion: 1,
          rulesHash: EQUITY_ALERT_RULES_HASH,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      },
    ];

    // First save: inserts 2 rows
    const firstResult = await alertRepo.saveAlerts(alertsToSave);
    expect(firstResult.inserted).toBe(2);
    expect(firstResult.skipped).toBe(0);

    const alertsAfterFirst = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: evalDate });
    expect(alertsAfterFirst.length).toBe(2);
    // Verified initial state is NEW
    for (const a of alertsAfterFirst) {
      expect(a.status).toBe("NEW");
    }

    // Second save with exact same alerts: ON CONFLICT DO NOTHING must add 0 rows!
    const secondResult = await alertRepo.saveAlerts(alertsToSave);
    expect(secondResult.inserted).toBe(0);
    expect(secondResult.skipped).toBe(2);

    const alertsAfterSecond = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: evalDate });
    expect(alertsAfterSecond.length).toBe(2); // Strict invariant: 0 rows added!
  });

  it("Gate E8: Manual events refuse non-https URLs in the API and at the database constraint level", async () => {
    // 1. Repository / API level validation rejects non-https
    await expect(
      eventFlagRepo.saveManualEvent({
        stockId: testStockId,
        kind: "RESULTS_DATE_UPCOMING",
        eventDate: "2026-10-25",
        headline: "Q2 Results Announcement",
        sourceUrl: "http://nseindia.com/reports/123", // Non-https rejected
      }),
    ).rejects.toThrow(/Gate E8/);

    await expect(
      eventFlagRepo.saveManualEvent({
        stockId: testStockId,
        kind: "RESULTS_DATE_UPCOMING",
        eventDate: "2026-10-25",
        headline: "Q2 Results Announcement",
        sourceUrl: "ftp://nseindia.com/reports/123", // Non-https rejected
      }),
    ).rejects.toThrow(/Gate E8/);

    await expect(
      eventFlagRepo.saveManualEvent({
        stockId: testStockId,
        kind: "RESULTS_DATE_UPCOMING",
        eventDate: "2026-10-25",
        headline: "Q2 Results Announcement",
        sourceUrl: "", // Empty URL rejected
      }),
    ).rejects.toThrow(/Gate E8/);

    // 2. Direct SQL insert bypass attempt: Database check constraint event_flag_manual_https_check strictly refuses it
    await expect(
      pool.query(
        `
        INSERT INTO equity_research.event_flag (
          stock_id, kind, origin, event_date, headline, source_url
        )
        VALUES ($1, 'MATERIAL_NEGATIVE', 'MANUAL', '2026-10-20', 'Auditor Resignation', 'http://insecure-source.com')
        `,
        [testStockId],
      ),
    ).rejects.toThrow(/event_flag_manual_https_check/);

    // Direct SQL insert with NULL source_url for MANUAL origin is also strictly refused
    await expect(
      pool.query(
        `
        INSERT INTO equity_research.event_flag (
          stock_id, kind, origin, event_date, headline, source_url
        )
        VALUES ($1, 'MATERIAL_NEGATIVE', 'MANUAL', '2026-10-20', 'Auditor Resignation', NULL)
        `,
        [testStockId],
      ),
    ).rejects.toThrow(/event_flag_manual_https_check/);

    // 3. Valid https URL succeeds cleanly
    const saved = await eventFlagRepo.saveManualEvent({
      stockId: testStockId,
      kind: "RESULTS_DATE_UPCOMING",
      eventDate: "2026-10-25",
      headline: "Q2 Results Board Meeting Announcement",
      sourceUrl: "https://www.nseindia.com/corporate/announcements/12345",
    });
    expect(saved.id).toBeDefined();
    expect(saved.origin).toBe("MANUAL");
    expect(saved.source_url).toBe("https://www.nseindia.com/corporate/announcements/12345");
  });

  it("Gate E9: Immutability - editing a manual event creates a revision; the old row remains unchanged", async () => {
    // 1. Initial event
    const original = await eventFlagRepo.saveManualEvent({
      stockId: testStockId,
      kind: "MANAGEMENT",
      eventDate: "2026-10-21",
      headline: "CEO Resignation Initial Notice",
      sourceUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/111.pdf",
    });

    // 2. Edit event pointing to original via supersedesId
    const revised = await eventFlagRepo.saveManualEvent({
      stockId: testStockId,
      kind: "MANAGEMENT",
      eventDate: "2026-10-21",
      headline: "CEO Resignation and Interim Successor Named",
      sourceUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/222.pdf",
      supersedesId: original.id,
    });

    expect(revised.id).not.toBe(original.id);
    expect(revised.supersedes_id).toBe(original.id);

    // 3. Verify original row is unchanged in database
    const fetchedOriginal = await eventFlagRepo.getEventById(original.id);
    expect(fetchedOriginal).not.toBeNull();
    expect(fetchedOriginal?.headline).toBe("CEO Resignation Initial Notice");
    expect(fetchedOriginal?.source_url).toBe("https://www.bseindia.com/xml-data/corpfiling/AttachLive/111.pdf");
    expect(fetchedOriginal?.supersedes_id).toBeNull();

    // 4. Verify history in getEventsByStockId contains both revisions
    const allEvents = await eventFlagRepo.getEventsByStockId(testStockId, { origin: "MANUAL" });
    const originalInList = allEvents.find((e) => e.id === original.id);
    const revisedInList = allEvents.find((e) => e.id === revised.id);
    expect(originalInList).toBeDefined();
    expect(revisedInList).toBeDefined();
    expect(revisedInList?.supersedes_id).toBe(original.id);
  });

  it("Gate E16: getRecentAlertsForStock MUST include the latest DATA_HEALTH alert regardless of age", async () => {
    // 1. Insert an ancient DATA_HEALTH alert from 90 days ago
    const ancientHealthDate = "2026-07-01";
    await alertRepo.saveAlerts([
      {
        stockId: testStockId,
        kind: "DATA_HEALTH",
        levelKey: null,
        evaluatedDate: ancientHealthDate,
        severity: "NOTICE",
        title: "Data health notice: Entering unhealthy state - Data is stale",
        payload: {
          close: 80.0,
          evaluatedDate: ancientHealthDate,
          subtype: "UNHEALTHY_ENTER",
          seriesVersion: 1,
          rulesHash: EQUITY_ALERT_RULES_HASH,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      },
    ]);

    // 2. Insert a recent LEVEL_APPROACH alert from 10 days ago
    const recentAlertDate = "2026-10-05";
    await alertRepo.saveAlerts([
      {
        stockId: testStockId,
        kind: "LEVEL_APPROACH",
        levelKey: "SWING_82.00",
        evaluatedDate: recentAlertDate,
        severity: "INFO",
        title: "Approaching swing level",
        payload: {
          close: 82.5,
          evaluatedDate: recentAlertDate,
          seriesVersion: 1,
          rulesHash: EQUITY_ALERT_RULES_HASH,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      },
    ]);

    // 3. Query recent alerts as of 2026-10-15 with standard 30-day lookback
    const recentAlerts = await alertRepo.getRecentAlertsForStock(testStockId, {
      asOfDate: "2026-10-15",
      lookbackCalendarDays: 30,
    });

    // Invariant (Gate E16): Even though 2026-07-01 is 106 days before 2026-10-15 (far beyond 30 days),
    // the latest DATA_HEALTH alert MUST be present in the returned list!
    const foundHealthAlert = recentAlerts.find((a) => a.kind === "DATA_HEALTH");
    expect(foundHealthAlert).toBeDefined();
    expect(foundHealthAlert?.evaluatedDate).toBe("2026-07-01");
    expect(foundHealthAlert?.payload?.subtype).toBe("UNHEALTHY_ENTER");

    // The recent level approach is also present
    const foundLevelAlert = recentAlerts.find((a) => a.kind === "LEVEL_APPROACH");
    expect(foundLevelAlert).toBeDefined();
  });

  it("Gate E12 & E2: Weekend and holiday dates produce no evaluation, and evaluation uses bars up to T only", async () => {
    // Seed price bars up to 2026-10-16 (Friday)
    const seedBars = [];
    let basePrice = 100;
    for (let i = 20; i >= 1; i--) {
      const d = new Date(Date.UTC(2026, 9, 16 - i));
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; // Skip weekends
      const dateStr = d.toISOString().split("T")[0];
      basePrice += (i % 2 === 0 ? 0.5 : -0.3);
      seedBars.push({
        stockId: testStockId,
        barDate: dateStr,
        open: basePrice,
        high: basePrice + 1.0,
        low: basePrice - 1.0,
        close: basePrice + 0.2,
        volume: 500000,
        source: TEST_SOURCE,
      });
    }

    // Add Friday bar
    seedBars.push({
      stockId: testStockId,
      barDate: "2026-10-16",
      open: 105.0,
      high: 106.0,
      low: 104.0,
      close: 105.5,
      volume: 600000,
      source: TEST_SOURCE,
    });

    await priceBarRepo.saveBars(seedBars);

    const stock = (await watchlistRepo.findById(testStockId))!;

    // 1. Evaluating on a weekend (2026-10-18 Sunday): must produce 0 evaluated alerts (Gate E12)
    const weekendEval = await evalService.evaluateAll("2026-10-18");
    expect(weekendEval.stocksEvaluated).toBe(0);
    expect(weekendEval.totalAlertsEmitted).toBe(0);
    expect(weekendEval.message).toMatch(/Weekend date/);

    // 2. Evaluating a stock on a date where no bar exists: returns evaluated = false
    const missingDateEval = await evalService.evaluateStock(stock, "2026-10-17"); // Saturday
    expect(missingDateEval.evaluated).toBe(false);
    expect(missingDateEval.alertsEmitted).toBe(0);

    // 3. Gate E2: Point-in-time enforcement
    // Fetching bars up to 2026-10-10 must NEVER include bars from 2026-10-16
    const barsUpToCut = await priceBarRepo.getBarsUpToDate(testStockId, "2026-10-10", 600);
    for (const b of barsUpToCut) {
      expect(b.bar_date <= "2026-10-10").toBe(true);
    }
  });

  it("Alert state transition lifecycle (NEW -> SEEN -> DISMISSED)", async () => {
    const evalDate = "2026-10-16";
    const saveRes = await alertRepo.saveAlerts([
      {
        stockId: testStockId,
        kind: "LARGE_MOVE",
        levelKey: null,
        evaluatedDate: evalDate,
        severity: "INFO",
        title: "Large move test",
        payload: {
          close: 105.5,
          evaluatedDate: evalDate,
          seriesVersion: 1,
          rulesHash: EQUITY_ALERT_RULES_HASH,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      },
    ]);

    expect(saveRes.insertedIds.length).toBe(1);
    const alertId = saveRes.insertedIds[0];

    // Initial state is NEW
    const initial = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: evalDate });
    const target = initial.find((a) => a.id === alertId);
    expect(target?.status).toBe("NEW");

    // Transition to SEEN
    await alertRepo.updateAlertState(alertId, "SEEN");
    const seenAlerts = await alertRepo.getAlerts({ stockId: testStockId, status: "SEEN" });
    expect(seenAlerts.some((a) => a.id === alertId)).toBe(true);

    // Transition to DISMISSED
    await alertRepo.updateAlertState(alertId, "DISMISSED");
    const dismissedAlerts = await alertRepo.getAlerts({ stockId: testStockId, status: "DISMISSED" });
    expect(dismissedAlerts.some((a) => a.id === alertId)).toBe(true);
  });
});
