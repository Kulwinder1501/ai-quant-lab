import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "dotenv/config";
import { loadEnvironment } from "../../../../config/environment.js";
import { createDatabasePool } from "../../../../infrastructure/database/database.js";
import type { Pool } from "pg";
import { PostgresEquityWatchlistRepository } from "./postgres-equity-watchlist-repository.js";
import { PostgresEquityPriceBarRepository } from "./postgres-equity-price-bar-repository.js";
import { PostgresEquityAlertRepository } from "./postgres-equity-alert-repository.js";
import { PostgresEquityEventFlagRepository } from "./postgres-equity-event-flag-repository.js";
import { PostgresEquitySourceHealthRepository } from "./postgres-equity-source-health-repository.js";
import { PostgresEquityCorporateActionRepository } from "./postgres-equity-corporate-action-repository.js";
import { EquityAlertsEvaluationService } from "../../application/equity-alerts-evaluation-service.js";
import { EQUITY_ALERT_FOOTER, EQUITY_ALERT_RULES_HASH } from "../../domain/alert-rules.js";

describe("Postgres Equity Alerts & Event Flags Integration (Gates E1, E2, E8, E9, E12, E16)", () => {
  let pool: Pool;
  let watchlistRepo: PostgresEquityWatchlistRepository;
  let priceBarRepo: PostgresEquityPriceBarRepository;
  let alertRepo: PostgresEquityAlertRepository;
  let eventFlagRepo: PostgresEquityEventFlagRepository;
  let sourceHealthRepo: PostgresEquitySourceHealthRepository;
  let corporateActionRepo: PostgresEquityCorporateActionRepository;
  let evalService: EquityAlertsEvaluationService;

  const TEST_SYMBOL = "TEST_ALERTS_STOCK";
  const TEST_TMPV_SYMBOL = "TEST_TMPV_STOCK";
  const TEST_MISSING_SYMBOL = "TEST_MISSING_STOCK";
  const TEST_SOURCE = "TEST_ALERTS_SOURCE";

  let testStockId: string;
  let tmpvStockId: string;
  let missingStockId: string;

  async function cleanupStockBySymbol(symbol: string) {
    const existing = await watchlistRepo.findBySymbol("NSE", symbol);
    if (existing) {
      await alertRepo.deleteAlertsForStock(existing.id);
      await eventFlagRepo.deleteEventsForStock(existing.id);
      await corporateActionRepo.deleteDerivedRows(existing.id);
      await pool.query(`DELETE FROM equity_research.price_bar_revision WHERE stock_id = $1`, [existing.id]);
      await priceBarRepo.deleteDerivedRows(existing.id);
      await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE id = $1`, [existing.id]);
    }
  }

  beforeAll(async () => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);
    watchlistRepo = new PostgresEquityWatchlistRepository(pool);
    priceBarRepo = new PostgresEquityPriceBarRepository(pool);
    alertRepo = new PostgresEquityAlertRepository(pool);
    eventFlagRepo = new PostgresEquityEventFlagRepository(pool);
    sourceHealthRepo = new PostgresEquitySourceHealthRepository(pool);
    corporateActionRepo = new PostgresEquityCorporateActionRepository(pool);
    evalService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
    );

    // Clean up any stale test stock data
    await cleanupStockBySymbol(TEST_SYMBOL);
    await cleanupStockBySymbol(TEST_TMPV_SYMBOL);
    await cleanupStockBySymbol(TEST_MISSING_SYMBOL);

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
      await cleanupStockBySymbol(TEST_SYMBOL);
      await cleanupStockBySymbol(TEST_TMPV_SYMBOL);
      await cleanupStockBySymbol(TEST_MISSING_SYMBOL);
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

  it("Gate E6 end-to-end: TMPV demerger (-40.15% on 2025-10-14) produces DATA_EVENT, creates event flag, and next day cites corporate action date in DATA_HEALTH", async () => {
    const tmpvStock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_TMPV_SYMBOL,
      yahooSymbol: `${TEST_TMPV_SYMBOL}.NS`,
      displayName: "Synthetic TMPV Demerger Stock",
    });
    tmpvStockId = tmpvStock.id;

    // Seed 30 bars up to 2025-10-13 at ~100
    const seedBars = [];
    const baseDate = new Date("2025-09-01T00:00:00Z");
    let barCount = 0;
    const d = new Date(baseDate);
    while (barCount < 30) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
        const dateStr = d.toISOString().split("T")[0];
        if (dateStr >= "2025-10-14") break;
        seedBars.push({
          stockId: tmpvStockId,
          barDate: dateStr,
          open: 100.0,
          high: 102.0,
          low: 98.0,
          close: 100.0,
          volume: 1000000,
          source: TEST_SOURCE,
        });
        barCount++;
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    // Day of demerger: 2025-10-14, drop of -40.15% (from 100.0 to 59.85)
    seedBars.push({
      stockId: tmpvStockId,
      barDate: "2025-10-14",
      open: 60.0,
      high: 61.0,
      low: 58.0,
      close: 59.85,
      volume: 5000000,
      source: TEST_SOURCE,
    });

    await priceBarRepo.saveBars(seedBars);

    // Evaluate 2025-10-14
    const evalResult = await evalService.evaluateStock(tmpvStock, "2025-10-14");
    expect(evalResult.evaluated).toBe(true);
    expect(evalResult.alertsEmitted).toBe(1);

    const alertsOnMove = await alertRepo.getAlerts({ stockId: tmpvStockId, evaluatedDate: "2025-10-14" });
    const dataEventAlert = alertsOnMove.find((a) => a.kind === "DATA_EVENT");
    const dataHealthAlert = alertsOnMove.find((a) => a.kind === "DATA_HEALTH");
    const largeMoveAlert = alertsOnMove.find((a) => a.kind === "LARGE_MOVE");

    expect(dataEventAlert).toBeDefined();
    expect(dataEventAlert?.title).toContain("-40.15%");
    expect(dataEventAlert?.title).toContain("possible corporate action");
    expect(dataHealthAlert).toBeUndefined();
    expect(largeMoveAlert).toBeUndefined();

    // Verify event flag recorded in equity_research.event_flag
    const flags = await eventFlagRepo.getEventsByStockId(tmpvStockId, { origin: "DETECTED" });
    const demergerFlag = flags.find((f) => f.event_date === "2025-10-14" && f.kind === "CORPORATE_ACTION");
    expect(demergerFlag).toBeDefined();
    expect(demergerFlag?.headline).toContain("-40.15%");

    // Day after: 2025-10-15 (close 59.50)
    await priceBarRepo.saveBars([
      {
        stockId: tmpvStockId,
        barDate: "2025-10-15",
        open: 59.85,
        high: 60.50,
        low: 59.00,
        close: 59.50,
        volume: 800000,
        source: TEST_SOURCE,
      },
    ]);

    const nextDayResult = await evalService.evaluateStock(tmpvStock, "2025-10-15");
    expect(nextDayResult.evaluated).toBe(true);
    expect(nextDayResult.alertsEmitted).toBe(1);

    const alertsNextDay = await alertRepo.getAlerts({ stockId: tmpvStockId, evaluatedDate: "2025-10-15" });
    const nextDayHealthAlert = alertsNextDay.find((a) => a.kind === "DATA_HEALTH");
    expect(nextDayHealthAlert).toBeDefined();
    expect(nextDayHealthAlert?.payload_json.subtype).toBe("UNHEALTHY_ENTER");
    expect(nextDayHealthAlert?.payload_json.reason).toContain("possible corporate action on 2025-10-14");

    // Second day after: 2025-10-16 (close 60.00) -> Throttled!
    await priceBarRepo.saveBars([
      {
        stockId: tmpvStockId,
        barDate: "2025-10-16",
        open: 59.50,
        high: 60.50,
        low: 59.20,
        close: 60.00,
        volume: 750000,
        source: TEST_SOURCE,
      },
    ]);

    const day2Result = await evalService.evaluateStock(tmpvStock, "2025-10-16");
    expect(day2Result.alertsEmitted).toBe(0); // Throttled!
  });

  it("Stored SPLIT in corporate_action produces DATA_EVENT under evaluateAll without options", async () => {
    // Clear previous alerts for testStockId on 2026-10-16
    await pool.query(
      `DELETE FROM equity_research.alert WHERE stock_id = $1 AND evaluated_date = '2026-10-16'`,
      [testStockId],
    );

    // Insert SPLIT row
    await pool.query(
      `
      INSERT INTO equity_research.corporate_action (
        id, stock_id, ex_date, kind, value, source, first_seen_at
      ) VALUES (
        gen_random_uuid(), $1, '2026-10-16', 'SPLIT', 2.0, $2, CURRENT_TIMESTAMP
      )
      `,
      [testStockId, TEST_SOURCE],
    );

    const stock = (await watchlistRepo.findById(testStockId))!;
    const evalRes = await evalService.evaluateAll("2026-10-16", { symbol: stock.symbol });
    expect(evalRes.totalAlertsEmitted).toBeGreaterThanOrEqual(1);

    const alerts = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: "2026-10-16" });
    const splitAlert = alerts.find((a) => a.kind === "DATA_EVENT" && a.payload_json.subtype === "SPLIT");
    expect(splitAlert).toBeDefined();
    expect(splitAlert?.title).toContain("Stock split effective on 2026-10-16");
    expect(splitAlert?.payload_json.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);
    expect(splitAlert?.payload_json.disclaimer).toBe(EQUITY_ALERT_FOOTER);
  });

  it("Stored revision in price_bar_revision produces DATA_EVENT under evaluateAll without options", async () => {
    // Clear previous alerts for testStockId on 2026-10-16 and delete corporate actions
    await pool.query(
      `DELETE FROM equity_research.alert WHERE stock_id = $1 AND evaluated_date = '2026-10-16'`,
      [testStockId],
    );
    await corporateActionRepo.deleteDerivedRows(testStockId);

    // Insert price bar revision
    await pool.query(
      `
      INSERT INTO equity_research.price_bar_revision (
        id, stock_id, bar_date, previous_values, new_values, seen_at
      ) VALUES (
        gen_random_uuid(), $1, '2026-10-10', '{"close": 100}'::jsonb, '{"close": 98}'::jsonb, '2026-10-16 10:00:00Z'
      )
      `,
      [testStockId],
    );

    const stock = (await watchlistRepo.findById(testStockId))!;
    const evalRes = await evalService.evaluateAll("2026-10-16", { symbol: stock.symbol });
    expect(evalRes.totalAlertsEmitted).toBeGreaterThanOrEqual(1);

    const alerts = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: "2026-10-16" });
    const restatementAlert = alerts.find((a) => a.kind === "DATA_EVENT" && a.payload_json.subtype === "RESTATEMENT");
    expect(restatementAlert).toBeDefined();
    expect(restatementAlert?.title).toContain("Historical price restatement detected");
    expect(restatementAlert?.payload_json.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);
    expect(restatementAlert?.payload_json.disclaimer).toBe(EQUITY_ALERT_FOOTER);
  });

  it("Missing price bar on active trading day raises DATA_HEALTH notice; market holiday produces 0 alerts", async () => {
    const missingStock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_MISSING_SYMBOL,
      yahooSymbol: `${TEST_MISSING_SYMBOL}.NS`,
      displayName: "Synthetic Stock Missing Bar",
    });
    missingStockId = missingStock.id;

    // missingStock has NO bar for 2026-10-16 (an active trading day because testStockId has bar for 2026-10-16)
    const directEval = await evalService.evaluateStock(missingStock, "2026-10-16");
    expect(directEval.evaluated).toBe(true);
    expect(directEval.alertsEmitted).toBe(1);

    const alerts = await alertRepo.getAlerts({ stockId: missingStockId, evaluatedDate: "2026-10-16" });
    const missingHealthAlert = alerts.find((a) => a.kind === "DATA_HEALTH");
    expect(missingHealthAlert).toBeDefined();
    expect(missingHealthAlert?.title).toContain("Missing price bar on trading day 2026-10-16");
    expect(missingHealthAlert?.payload_json.subtype).toBe("UNHEALTHY_ENTER");
    expect(missingHealthAlert?.payload_json.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);
    expect(missingHealthAlert?.payload_json.disclaimer).toBe(EQUITY_ALERT_FOOTER);

    // Re-evaluating on same day is throttled:
    const reEval = await evalService.evaluateStock(missingStock, "2026-10-16");
    expect(reEval.alertsEmitted).toBe(0);

    // Market holiday check: evaluating on a weekday with zero bars across entire database (e.g. 2026-05-01)
    const holidayEval = await evalService.evaluateStock(missingStock, "2026-05-01");
    expect(holidayEval.evaluated).toBe(false);
    expect(holidayEval.alertsEmitted).toBe(0);
  });

  it("Gate E10: Evaluation error during evaluateAll persists DATA_HEALTH row while collection succeeds", async () => {
    const failingPriceBarRepo = {
      getBarsUpToDate: vi.fn().mockImplementation((stockId: string, date: string, limit: number) => {
        if (stockId === testStockId) {
          throw new Error("Simulated transient connection timeout");
        }
        return priceBarRepo.getBarsUpToDate(stockId, date, limit);
      }),
      hasAnyBarOnDate: vi.fn().mockResolvedValue(true),
    } as unknown as PostgresEquityPriceBarRepository;

    const isolatedEvalService = new EquityAlertsEvaluationService(
      watchlistRepo,
      failingPriceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
    );

    // Clear any previous alerts for testStockId on 2026-10-16
    await pool.query(
      `DELETE FROM equity_research.alert WHERE stock_id = $1 AND evaluated_date = '2026-10-16'`,
      [testStockId],
    );

    // evaluateAll must NOT throw
    const evalRes = await isolatedEvalService.evaluateAll("2026-10-16", { symbol: TEST_SYMBOL });
    expect(evalRes).toBeDefined();

    const alerts = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: "2026-10-16" });
    const errAlert = alerts.find((a) => a.kind === "DATA_HEALTH" && a.title.includes("Evaluation error"));
    expect(errAlert).toBeDefined();
    expect(errAlert?.payload_json.reason).toContain("Simulated transient connection timeout");
    expect(errAlert?.payload_json.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);
    expect(errAlert?.payload_json.disclaimer).toBe(EQUITY_ALERT_FOOTER);
  });

  it("Stored payload invariants: rulesHash is 64-hex SHA-256, disclaimer is EQUITY_ALERT_FOOTER, zero banned words", async () => {
    const allAlerts = await pool.query<{ payload_json: any; title: string; kind: string }>(
      `SELECT payload_json, title, kind FROM equity_research.alert WHERE stock_id IN ($1, $2, $3)`,
      [testStockId, tmpvStockId, missingStockId],
    );

    expect(allAlerts.rows.length).toBeGreaterThan(0);

    const bannedWords = [
      "buy", "sell", "hold", "bullish", "bearish", "strong", "weak",
      "overbought", "oversold", "signal", "target", "outperform", "underperform", "recommend"
    ];

    for (const row of allAlerts.rows) {
      const payload = row.payload_json;
      // 1. Strict 64-hex SHA-256 hash
      expect(payload.rulesHash).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);

      // 2. Alert footer disclaimer (NOT levels disclaimer)
      expect(payload.disclaimer).toBe(EQUITY_ALERT_FOOTER);

      // 3. Gate E11: No banned words in title
      const lowerTitle = row.title.toLowerCase();
      for (const banned of bannedWords) {
        const regex = new RegExp(`\\b${banned}\\b`, "i");
        expect(regex.test(lowerTitle)).toBe(false);
      }

      // 4. Gate E11: No banned words in payload reason if present
      if (typeof payload.reason === "string") {
        const lowerReason = payload.reason.toLowerCase();
        for (const banned of bannedWords) {
          const regex = new RegExp(`\\b${banned}\\b`, "i");
          expect(regex.test(lowerReason)).toBe(false);
        }
      }
    }
  });
});
