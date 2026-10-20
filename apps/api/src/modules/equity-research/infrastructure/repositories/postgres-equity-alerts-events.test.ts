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
import { PostgresEquitySecondaryFactRepository } from "./postgres-equity-secondary-fact-repository.js";
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
  let secondaryFactRepo: PostgresEquitySecondaryFactRepository;
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
      await secondaryFactRepo.deleteDerivedRows(existing.id);
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
    secondaryFactRepo = new PostgresEquitySecondaryFactRepository(pool);
    process.env.NSE_HOLIDAYS = "2026-05-01";
    evalService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
      secondaryFactRepo,
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
      await sourceHealthRepo.setStatus("YAHOO", "chart", "OK");
      await sourceHealthRepo.setStatus("YAHOO", "quote", "OK");
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

    // 4. By default, only current revision is returned (superseded original is hidden)
    const currentEvents = await eventFlagRepo.getEventsByStockId(testStockId, { origin: "MANUAL" });
    expect(currentEvents.find((e) => e.id === original.id)).toBeUndefined();
    expect(currentEvents.find((e) => e.id === revised.id)).toBeDefined();

    // 5. With includeHistory: true, both revisions are returned
    const allEvents = await eventFlagRepo.getEventsByStockId(testStockId, { origin: "MANUAL", includeHistory: true });
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

  it("Condition 1: newly added stock with historical 2008 split gets no alert, and a split on the evaluation date does", async () => {
    const TEST_COND1_SYMBOL = "TESTSPLIT08";
    await cleanupStockBySymbol(TEST_COND1_SYMBOL);

    const stock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_COND1_SYMBOL,
      yahooSymbol: `${TEST_COND1_SYMBOL}.NS`,
      displayName: "Synthetic Stock With 2008 Split",
    });

    try {
      // Seed historical bars up to 2026-10-16
      const barsToInsert = [];
      const baseDate = new Date("2026-09-15T00:00:00Z");
      for (let i = 0; i < 40; i++) {
        const d = new Date(baseDate.getTime() + i * 86400000);
        const dayOfWeek = d.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const dateStr = d.toISOString().split("T")[0];
        if (dateStr > "2026-10-16") break;
        barsToInsert.push({
          stockId: stock.id,
          barDate: dateStr,
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 50000,
        });
      }
      await priceBarRepo.saveBars(barsToInsert);

      // Insert historical 2008 split added today (first_seen_at = today, but ex_date = 2008-06-15)
      await pool.query(
        `
        INSERT INTO equity_research.corporate_action (
          id, stock_id, ex_date, kind, value, source, first_seen_at
        ) VALUES (
          gen_random_uuid(), $1, '2008-06-15', 'SPLIT', 2.0, $2, CURRENT_TIMESTAMP
        )
        `,
        [stock.id, TEST_SOURCE],
      );

      // Evaluating on 2026-10-16: 2008 split MUST NOT produce any alert!
      await evalService.evaluateStock(stock, "2026-10-16");
      const alerts1 = await alertRepo.getAlerts({ stockId: stock.id, evaluatedDate: "2026-10-16" });
      const falseSplitAlert = alerts1.find((a) => a.kind === "DATA_EVENT" && a.payload_json.subtype === "SPLIT");
      expect(falseSplitAlert).toBeUndefined();

      // Now insert a real SPLIT effective on evaluation date 2026-10-16
      await pool.query(
        `
        INSERT INTO equity_research.corporate_action (
          id, stock_id, ex_date, kind, value, source, first_seen_at
        ) VALUES (
          gen_random_uuid(), $1, '2026-10-16', 'SPLIT', 5.0, $2, CURRENT_TIMESTAMP
        )
        `,
        [stock.id, TEST_SOURCE],
      );

      // Clear alerts and re-evaluate with real split
      await pool.query(`DELETE FROM equity_research.alert WHERE stock_id = $1`, [stock.id]);
      const eval2 = await evalService.evaluateStock(stock, "2026-10-16");
      expect(eval2.evaluated).toBe(true);

      const alerts2 = await alertRepo.getAlerts({ stockId: stock.id, evaluatedDate: "2026-10-16" });
      const realSplitAlert = alerts2.find((a) => a.kind === "DATA_EVENT" && a.payload_json.subtype === "SPLIT");
      expect(realSplitAlert).toBeDefined();
      expect(realSplitAlert?.title).toContain("Stock split effective on 2026-10-16");
    } finally {
      await cleanupStockBySymbol(TEST_COND1_SYMBOL);
    }
  });

  it("Condition 2: repeated evaluation errors throttle over consecutive days and carry lastKnownClose or null", async () => {
    const TEST_ERR_SYMBOL = "TESTERRSTK";
    await cleanupStockBySymbol(TEST_ERR_SYMBOL);

    const stock = await watchlistRepo.addStock({
      exchange: "NSE",
      symbol: TEST_ERR_SYMBOL,
      yahooSymbol: `${TEST_ERR_SYMBOL}.NS`,
      displayName: "Synthetic Error Throttle Stock",
    });

    try {
      // Insert one bar on 2026-10-13 so lastKnownClose = 150.5
      await priceBarRepo.saveBars([
        {
          stockId: stock.id,
          barDate: "2026-10-13",
          open: 150,
          high: 152,
          low: 149,
          close: 150.5,
          volume: 10000,
        },
      ]);

      const failingPriceBar = {
        getBarsUpToDate: vi.fn().mockImplementation((stockId: string, date: string, limit: number) => {
          if (stockId === stock.id && limit === 600) {
            throw new Error("Repeated persistent timeout");
          }
          return priceBarRepo.getBarsUpToDate(stockId, date, limit);
        }),
        hasAnyBarOnDate: vi.fn().mockResolvedValue(true),
      } as unknown as PostgresEquityPriceBarRepository;

      const failingService = new EquityAlertsEvaluationService(
        watchlistRepo,
        failingPriceBar,
        alertRepo,
        eventFlagRepo,
        sourceHealthRepo,
        corporateActionRepo,
        new Set(["2026-05-01"]),
      );

      // Day 1: 2026-10-14 -> enters unhealthy state
      const resDay1 = await failingService.evaluateAll("2026-10-14", { symbol: stock.symbol });
      expect(resDay1.totalAlertsEmitted).toBe(1);
      expect(resDay1.totalAlertsInserted).toBe(1);
      const day1Alerts = await alertRepo.getAlerts({ stockId: stock.id, evaluatedDate: "2026-10-14" });
      const day1Err = day1Alerts.find((a) => a.kind === "DATA_HEALTH");
      expect(day1Err).toBeDefined();
      expect(day1Err?.payload_json.subtype).toBe("UNHEALTHY_ENTER");
      expect(day1Err?.payload_json.close).toBe(150.5); // lastKnownClose, NOT 0!

      // Day 2: 2026-10-15 -> throttled! 0 alerts emitted, 0 alerts inserted (not hardcoded to 1)
      const resDay2 = await failingService.evaluateAll("2026-10-15", { symbol: stock.symbol });
      expect(resDay2.totalAlertsEmitted).toBe(0);
      expect(resDay2.totalAlertsInserted).toBe(0);
      expect(resDay2.results[0].alertsInserted).toBe(0);

      // Day 3: 2026-10-16 -> still throttled!
      const resDay3 = await failingService.evaluateAll("2026-10-16", { symbol: stock.symbol });
      expect(resDay3.totalAlertsEmitted).toBe(0);
      expect(resDay3.totalAlertsInserted).toBe(0);

      // Day 6: 2026-10-20 (diffDays = 6 >= 5) -> reminder UNHEALTHY_REPEAT emitted
      const resDay6 = await failingService.evaluateAll("2026-10-20", { symbol: stock.symbol });
      expect(resDay6.totalAlertsEmitted).toBe(1);
      expect(resDay6.totalAlertsInserted).toBe(1);
      const day6Alerts = await alertRepo.getAlerts({ stockId: stock.id, evaluatedDate: "2026-10-20" });
      const day6Err = day6Alerts.find((a) => a.kind === "DATA_HEALTH");
      expect(day6Err?.payload_json.subtype).toBe("UNHEALTHY_REPEAT");
      expect(day6Err?.payload_json.close).toBe(150.5); // not 0!
    } finally {
      await cleanupStockBySymbol(TEST_ERR_SYMBOL);
    }
  });

  it("Condition 3: full outage on non-holiday weekday raises source-level data-health notice, while listed holiday produces 0 alerts", async () => {
    // Case A: Exchange holiday in NSE_HOLIDAYS (2026-05-01 is in test holidays)
    // 0 bars stored anywhere in database on 2026-05-01
    const holidayRes = await evalService.evaluateAll("2026-05-01");
    expect(holidayRes.totalAlertsEmitted).toBe(0);
    expect(holidayRes.stocksEvaluated).toBe(0);
    expect(holidayRes.message).toContain("Exchange holiday (2026-05-01); zero alerts evaluated");

    // Case B: Non-holiday weekday with 0 bars stored anywhere in database (2026-10-28, a Wednesday)
    // 2026-10-28 is NOT in NSE_HOLIDAYS
    await alertRepo.deleteAlertsForStock(testStockId);
    const outageDate = "2026-10-28";
    const outageRes = await evalService.evaluateAll(outageDate, { symbol: TEST_SYMBOL });
    expect(outageRes.totalAlertsEmitted).toBeGreaterThanOrEqual(1);
    expect(outageRes.totalAlertsInserted).toBeGreaterThanOrEqual(1);

    // Source health status updated to mark outage
    const health = await sourceHealthRepo.getHealth("YAHOO", "chart");
    expect(health).toBeDefined();

    // Data-health alert emitted for stock
    const alerts = await alertRepo.getAlerts({ stockId: testStockId, evaluatedDate: outageDate });
    const outageAlert = alerts.find((a) => a.kind === "DATA_HEALTH");
    expect(outageAlert).toBeDefined();
    expect(outageAlert?.title).toContain("Data source is unavailable (zero price bars stored on trading day 2026-10-28)");
    expect(outageAlert?.payload_json.subtype).toBe("UNHEALTHY_ENTER");

    // Re-running evaluateAll on same outage date is idempotent
    const reOutageRes = await evalService.evaluateAll(outageDate, { symbol: TEST_SYMBOL });
    expect(reOutageRes.totalAlertsEmitted).toBe(0);
    expect(reOutageRes.totalAlertsInserted).toBe(0);

    // Clean up: restore source health to OK
    await sourceHealthRepo.setStatus("YAHOO", "chart", "OK");

    // Case C: Non-holiday weekday with 0 bars, BUT chart calls succeeded in source_call_log
    // (Evidence check: treated as no-new-data day, zero alerts emitted, source_health untouched)
    const noDataDate = "2026-10-27"; // Tuesday
    await pool.query(
      `INSERT INTO equity_research.source_call_log (source, endpoint, status, duration_ms, time)
       VALUES ('YAHOO', 'chart', 200, 150, ($1::date + time '17:05:00') AT TIME ZONE 'Asia/Kolkata')`,
      [noDataDate],
    );

    try {
      const noDataRes = await evalService.evaluateAll(noDataDate, { symbol: TEST_SYMBOL });
      expect(noDataRes.totalAlertsEmitted).toBe(0);
      expect(noDataRes.totalAlertsInserted).toBe(0);
      expect(noDataRes.message).toContain("treated as no-new-data day");

      // Verify YAHOO source health remained OK (never marked UNAVAILABLE)
      const healthAfter = await sourceHealthRepo.getHealth("YAHOO", "chart");
      expect(healthAfter?.status).toBe("OK");
    } finally {
      await pool.query(
        `DELETE FROM equity_research.source_call_log WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
        [noDataDate],
      );
      await sourceHealthRepo.setStatus("YAHOO", "chart", "OK");
    }
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

  describe("Step 5: Detected event flags (Gate Step 5)", () => {
    const TEST_STEP5_SYMBOL = "TEST_STEP5_STOCK";
    let step5StockId: string;

    beforeAll(async () => {
      await cleanupStockBySymbol(TEST_STEP5_SYMBOL);
      const stock = await watchlistRepo.addStock({
        exchange: "NSE",
        symbol: TEST_STEP5_SYMBOL,
        yahooSymbol: `${TEST_STEP5_SYMBOL}.NS`,
        displayName: "Synthetic Step 5 Stock",
      });
      step5StockId = stock.id;
    });

    afterAll(async () => {
      await cleanupStockBySymbol(TEST_STEP5_SYMBOL);
    });

    it("Initial stock backfill produces 0 detected event flags for past history", async () => {
      // Set added_at to 2026-10-20 (simulating newly added stock)
      await pool.query(
        `UPDATE equity_research.watchlist_stock SET added_at = '2026-10-20 00:00:00Z' WHERE id = $1`,
        [step5StockId],
      );

      // Save historical bars up to 2026-10-20
      await priceBarRepo.saveBars([
        {
          stockId: step5StockId,
          barDate: "2026-10-19",
          open: 100, high: 105, low: 99, close: 102, volume: 100000, source: TEST_SOURCE,
        },
        {
          stockId: step5StockId,
          barDate: "2026-10-20",
          open: 102, high: 106, low: 101, close: 104, volume: 120000, source: TEST_SOURCE,
        },
      ]);

      // Backfill historical split and historical quarterly facts
      await corporateActionRepo.saveActions([
        {
          stockId: step5StockId,
          exDate: "2026-10-20",
          kind: "SPLIT",
          value: 2.0,
          source: TEST_SOURCE,
        },
      ]);

      await secondaryFactRepo.saveFacts([
        {
          stockId: step5StockId,
          item: "quarterlyTotalRevenue",
          periodType: "QUARTERLY",
          periodEnd: "2026-06-30",
          value: 1000000000,
        },
        {
          stockId: step5StockId,
          item: "quarterlyNetIncome",
          periodType: "QUARTERLY",
          periodEnd: "2026-06-30",
          value: 100000000,
        },
      ]);

      // Evaluate for 2026-10-20 with isInitialLoad = true (or auto-detected from added_at >= evaluationDate)
      const stock = (await watchlistRepo.findById(step5StockId))!;
      const evalRes = await evalService.evaluateStock(stock, "2026-10-20");
      expect(evalRes.evaluated).toBe(true);

      // Verify that NO detected event flags were created for the backfilled history
      const flags = await eventFlagRepo.getEventsByStockId(step5StockId, { origin: "DETECTED" });
      const corpFlags = flags.filter((f) => f.kind === "CORPORATE_ACTION" || f.kind === "RESULTS_PUBLISHED");
      expect(corpFlags.length).toBe(0);
    });

    it("Subsequent EOD run records CORPORATE_ACTION flags for SPLIT and DIVIDEND with provenance disclaimer", async () => {
      // Simulate stock added earlier (e.g. 2026-10-01)
      await pool.query(
        `UPDATE equity_research.watchlist_stock SET added_at = '2026-10-01 00:00:00Z' WHERE id = $1`,
        [step5StockId],
      );

      // Add bars for 2026-10-21
      await priceBarRepo.saveBars([
        {
          stockId: step5StockId,
          barDate: "2026-10-21",
          open: 104, high: 108, low: 103, close: 105, volume: 150000, source: TEST_SOURCE,
        },
      ]);

      // Add new corporate actions effective on 2026-10-21: split and dividend
      await corporateActionRepo.saveActions([
        {
          stockId: step5StockId,
          exDate: "2026-10-21",
          kind: "SPLIT",
          value: 2.0,
          source: TEST_SOURCE,
        },
        {
          stockId: step5StockId,
          exDate: "2026-10-21",
          kind: "DIVIDEND",
          value: 3.5,
          source: TEST_SOURCE,
        },
      ]);

      const stock = (await watchlistRepo.findById(step5StockId))!;
      const evalRes = await evalService.evaluateStock(stock, "2026-10-21");
      expect(evalRes.evaluated).toBe(true);

      const flags = await eventFlagRepo.getEventsByStockId(step5StockId, {
        origin: "DETECTED",
        kind: "CORPORATE_ACTION",
      });

      const splitFlag = flags.find((f) => f.detail_json?.actionKind === "SPLIT");
      expect(splitFlag).toBeDefined();
      expect(splitFlag?.headline).toContain("Stock split effective 2026-10-21 (ratio 2)");
      expect(splitFlag?.headline).toContain("No future announcements available from this source.");
      expect(splitFlag?.event_date).toBe("2026-10-21");

      const divFlag = flags.find((f) => f.detail_json?.actionKind === "DIVIDEND");
      expect(divFlag).toBeDefined();
      expect(divFlag?.headline).toContain("Dividend effective 2026-10-21 (₹3.50 per share)");
      expect(divFlag?.headline).toContain("No future announcements available from this source.");
      expect(divFlag?.event_date).toBe("2026-10-21");

      // Idempotency check: running evaluateStock again must not add duplicate rows
      const evalRepeat = await evalService.evaluateStock(stock, "2026-10-21");
      expect(evalRepeat.evaluated).toBe(true);
      const flagsRepeat = await eventFlagRepo.getEventsByStockId(step5StockId, {
        origin: "DETECTED",
        kind: "CORPORATE_ACTION",
      });
      expect(flagsRepeat.length).toBe(flags.length);
    });

    it("Subsequent EOD run records RESULTS_PUBLISHED flag with YoY comparison and no banned words", async () => {
      // Prior quarter 1 year ago (2025-09-30) seen earlier
      await secondaryFactRepo.saveFacts([
        {
          stockId: step5StockId,
          item: "quarterlyTotalRevenue",
          periodType: "QUARTERLY",
          periodEnd: "2025-09-30",
          value: 1000000000, // 100 Cr
          firstSeenAt: "2025-11-01 10:00:00Z",
        },
        {
          stockId: step5StockId,
          item: "quarterlyNetIncome",
          periodType: "QUARTERLY",
          periodEnd: "2025-09-30",
          value: 100000000, // 10 Cr
          firstSeenAt: "2025-11-01 10:00:00Z",
        },
      ]);

      // Add bars for 2026-10-22
      await priceBarRepo.saveBars([
        {
          stockId: step5StockId,
          barDate: "2026-10-22",
          open: 105, high: 107, low: 104, close: 106, volume: 110000, source: TEST_SOURCE,
        },
      ]);

      // New quarter (2026-09-30) first seen on 2026-10-22: Revenue 125 Cr (+25% YoY), Net income 12 Cr (+20% YoY)
      await secondaryFactRepo.saveFacts([
        {
          stockId: step5StockId,
          item: "quarterlyTotalRevenue",
          periodType: "QUARTERLY",
          periodEnd: "2026-09-30",
          value: 1250000000, // 125 Cr
          firstSeenAt: "2026-10-22 17:00:00+05:30",
        },
        {
          stockId: step5StockId,
          item: "quarterlyNetIncome",
          periodType: "QUARTERLY",
          periodEnd: "2026-09-30",
          value: 120000000, // 12 Cr
          firstSeenAt: "2026-10-22 17:00:00+05:30",
        },
      ]);

      const stock = (await watchlistRepo.findById(step5StockId))!;
      const evalRes = await evalService.evaluateStock(stock, "2026-10-22");
      expect(evalRes.evaluated).toBe(true);

      const flags = await eventFlagRepo.getEventsByStockId(step5StockId, {
        origin: "DETECTED",
        kind: "RESULTS_PUBLISHED",
      });

      const resultsFlag = flags.find((f) => f.detail_json?.periodEnd === "2026-09-30");
      expect(resultsFlag).toBeDefined();
      expect(resultsFlag?.headline).toContain("Quarterly results published for period ending 2026-09-30");
      expect(resultsFlag?.headline).toContain("Revenue ₹125.00 Cr (+25.0% YoY)");
      expect(resultsFlag?.headline).toContain("Net income ₹12.00 Cr (+20.0% YoY)");
      expect(resultsFlag?.event_date).toBe("2026-10-22");

      // Verify detail json
      expect(resultsFlag?.detail_json.revenue).toBe(1250000000);
      expect(resultsFlag?.detail_json.priorRevenue).toBe(1000000000);
      expect(resultsFlag?.detail_json.revenueYoYPercent).toBe(25);
      expect(resultsFlag?.detail_json.netIncome).toBe(120000000);
      expect(resultsFlag?.detail_json.priorNetIncome).toBe(100000000);
      expect(resultsFlag?.detail_json.netIncomeYoYPercent).toBe(20);

      // Idempotency check: re-evaluation produces 0 duplicates
      await evalService.evaluateStock(stock, "2026-10-22");
      const flagsRepeat = await eventFlagRepo.getEventsByStockId(step5StockId, {
        origin: "DETECTED",
        kind: "RESULTS_PUBLISHED",
      });
      expect(flagsRepeat.length).toBe(flags.length);
    });

    it("Gate E11 scanner: All stored event flags contain zero banned words", async () => {
      const allFlags = await pool.query<{ headline: string; kind: string; detail_json: any }>(
        `SELECT headline, kind, detail_json FROM equity_research.event_flag WHERE stock_id = $1`,
        [step5StockId],
      );

      expect(allFlags.rows.length).toBeGreaterThan(0);

      const bannedWords = [
        "buy", "sell", "hold", "bullish", "bearish", "strong", "weak",
        "overbought", "oversold", "signal", "target", "outperform", "underperform", "recommend"
      ];

      for (const row of allFlags.rows) {
        const lowerHeadline = row.headline.toLowerCase();
        for (const banned of bannedWords) {
          const regex = new RegExp(`\\b${banned}\\b`, "i");
          expect(regex.test(lowerHeadline)).toBe(false);
        }

        const note = row.detail_json?.note;
        if (typeof note === "string") {
          const lowerNote = note.toLowerCase();
          for (const banned of bannedWords) {
            const regex = new RegExp(`\\b${banned}\\b`, "i");
            expect(regex.test(lowerNote)).toBe(false);
          }
        }
      }
    });
  });
});
