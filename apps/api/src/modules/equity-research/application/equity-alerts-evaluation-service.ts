import {
  EQUITY_ALERT_FOOTER,
  EQUITY_ALERT_RULES_HASH,
  evaluateAlerts,
  type EvaluatedAlert,
} from "../domain/alert-rules.js";
import { computeLevels } from "../domain/levels.js";
import { formatIstDateString } from "../domain/state-rules.js";
import type { WatchlistStockRecord } from "../domain/types.js";
import type { PostgresEquityAlertRepository } from "../infrastructure/repositories/postgres-equity-alert-repository.js";
import type { PostgresEquityCorporateActionRepository } from "../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import type { PostgresEquityEventFlagRepository } from "../infrastructure/repositories/postgres-equity-event-flag-repository.js";
import type { PostgresEquityPriceBarRepository } from "../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import type { PostgresEquitySourceHealthRepository } from "../infrastructure/repositories/postgres-equity-source-health-repository.js";
import type { PostgresEquityWatchlistRepository } from "../infrastructure/repositories/postgres-equity-watchlist-repository.js";

export interface StockAlertEvaluationResult {
  stockId: string;
  symbol: string;
  evaluatedDate: string;
  evaluated: boolean;
  alertsEmitted: number;
  alertsInserted: number;
  alertsSkipped: number;
  alerts: EvaluatedAlert[];
  reason?: string;
}

export interface AlertEvaluationSummary {
  evaluationDate: string;
  totalStocks: number;
  stocksEvaluated: number;
  stocksSkipped: number;
  totalAlertsEmitted: number;
  totalAlertsInserted: number;
  totalAlertsSkipped: number;
  results: StockAlertEvaluationResult[];
  message?: string;
}

export class EquityAlertsEvaluationService {
  constructor(
    private readonly watchlistRepo: PostgresEquityWatchlistRepository,
    private readonly priceBarRepo: PostgresEquityPriceBarRepository,
    private readonly alertRepo: PostgresEquityAlertRepository,
    private readonly eventFlagRepo: PostgresEquityEventFlagRepository,
    private readonly sourceHealthRepo: PostgresEquitySourceHealthRepository,
    private readonly corporateActionRepo?: PostgresEquityCorporateActionRepository,
  ) {}

  /**
   * Evaluates End-of-Day alerts for a single stock.
   * Gates satisfied:
   * - E1: Idempotent duplicate runs add 0 rows (ON CONFLICT DO NOTHING).
   * - E2: Point-in-time enforcement: only price bars up to evaluationDate are queried.
   * - E5: Non-OK stocks produce throttled DATA_HEALTH alerts and 0 level alerts.
   * - E6: Demerger / 40%+ move yields DATA_EVENT (possible corporate action), never LARGE_MOVE.
   * - E12: If no bar exists on evaluationDate (weekend, holiday, missing bar), returns 0 alerts.
   * - E16: Passes recentAlerts containing the latest DATA_HEALTH alert regardless of age.
   */
  async evaluateStock(
    stock: WatchlistStockRecord,
    evaluationDate: string,
    options?: {
      isOldRestatement?: boolean;
      hasNewSplit?: boolean;
      isTradingDay?: boolean;
    },
  ): Promise<StockAlertEvaluationResult> {
    const result: StockAlertEvaluationResult = {
      stockId: stock.id,
      symbol: stock.symbol,
      evaluatedDate: evaluationDate,
      evaluated: false,
      alertsEmitted: 0,
      alertsInserted: 0,
      alertsSkipped: 0,
      alerts: [],
    };

    // 1. Fetch bars strictly up to evaluationDate (Gate E2: point-in-time enforcement)
    const bars = await this.priceBarRepo.getBarsUpToDate(stock.id, evaluationDate, 600);

    const hasBarOnDate = Boolean(
      bars && bars.length > 0 && bars[bars.length - 1].bar_date === evaluationDate,
    );

    if (!hasBarOnDate) {
      // Gate E12: Weekend guard (Saturday = 6, Sunday = 0)
      const dateObj = new Date(`${evaluationDate}T00:00:00Z`);
      const dayOfWeek = dateObj.getUTCDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        result.reason = `Weekend date ${evaluationDate} (Gate E12)`;
        return result;
      }

      // Check if evaluationDate is an active trading day across the market
      const isTradingDay =
        options?.isTradingDay !== undefined
          ? options.isTradingDay
          : await this.priceBarRepo.hasAnyBarOnDate(evaluationDate);

      if (!isTradingDay) {
        result.reason = `No bars stored for any stock on ${evaluationDate} (market holiday / non-trading day); zero alerts evaluated (Gate E12)`;
        return result;
      }

      // It IS a trading day, but this active stock stored NO bar on evaluationDate!
      // This is an unhealthy-data event: emit throttled DATA_HEALTH alert.
      return await this.handleMissingBarStock(stock, evaluationDate);
    }

    const lastBar = bars[bars.length - 1];

    // 2. Fetch recent alerts including the single latest DATA_HEALTH alert regardless of age (Gate E16)
    const recentAlerts = await this.alertRepo.getRecentAlertsForStock(stock.id, {
      asOfDate: evaluationDate,
      lookbackCalendarDays: 30,
    });

    // 3. Fetch source health status
    const sourceHealth = await this.sourceHealthRepo.getHealth("YAHOO", "chart");
    const sourceHealthStatus = sourceHealth?.status ?? "OK";

    // 4. Compute levels at T and T-1
    const levelsAtT = computeLevels({
      bars,
      rebackfillNeeded: stock.rebackfill_needed,
      asOfEvaluationDate: evaluationDate,
      seriesVersion: stock.series_version ?? 1,
    });

    let levelsAtTMinus1 = null;
    if (bars.length > 1) {
      const barsTMinus1 = bars.slice(0, bars.length - 1);
      const evalDateTMinus1 = barsTMinus1[barsTMinus1.length - 1].bar_date;
      levelsAtTMinus1 = computeLevels({
        bars: barsTMinus1,
        rebackfillNeeded: stock.rebackfill_needed,
        asOfEvaluationDate: evalDateTMinus1,
        seriesVersion: stock.series_version ?? 1,
      });
    }

    // 5. Evaluate pure alert rules (Gate E1, E2, E3, E4, E5, E6, E11, E12)
    const emitted = evaluateAlerts({
      stockId: stock.id,
      stockSymbol: stock.symbol,
      levelsAtT,
      levelsAtTMinus1,
      bars,
      recentAlerts,
      sourceHealthStatus,
      evaluationDate,
    });

    // 6. Check for extra DATA_EVENT conditions derived from stored database state
    // (A) Stored SPLIT corporate action effective on or first seen on evaluationDate
    const hasSplit =
      Boolean(options?.hasNewSplit) ||
      (this.corporateActionRepo
        ? await this.corporateActionRepo.hasSplitForDate(stock.id, evaluationDate)
        : false);

    // (B) Stored price-bar revision or re-backfill observed on evaluationDate
    const hasRevision =
      Boolean(options?.isOldRestatement) ||
      stock.rebackfill_needed ||
      (await this.priceBarRepo.hasRevisionsForDate(stock.id, evaluationDate));

    if (hasSplit) {
      const alreadyHasSplitAlert = emitted.some(
        (a) => a.kind === "DATA_EVENT" && a.payload.subtype === "SPLIT",
      );
      if (!alreadyHasSplitAlert) {
        emitted.push({
          stockId: stock.id,
          kind: "DATA_EVENT",
          levelKey: null,
          evaluatedDate: evaluationDate,
          severity: "NOTICE",
          title: `Stock split effective on ${evaluationDate} (possible corporate action).`,
          payload: {
            close: lastBar.close,
            evaluatedDate: evaluationDate,
            subtype: "SPLIT",
            seriesVersion: stock.series_version ?? 1,
            rulesHash: EQUITY_ALERT_RULES_HASH,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }

    if (hasRevision) {
      const alreadyHasRestatement = emitted.some(
        (a) => a.kind === "DATA_EVENT" && a.payload.subtype === "RESTATEMENT",
      );
      if (!alreadyHasRestatement) {
        emitted.push({
          stockId: stock.id,
          kind: "DATA_EVENT",
          levelKey: null,
          evaluatedDate: evaluationDate,
          severity: "NOTICE",
          title: "Historical price restatement detected for older bars.",
          payload: {
            close: lastBar.close,
            evaluatedDate: evaluationDate,
            subtype: "RESTATEMENT",
            seriesVersion: stock.series_version ?? 1,
            rulesHash: EQUITY_ALERT_RULES_HASH,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }

    // 7. Persist evaluated alerts idempotently (Gate E1)
    let saveResult = { inserted: 0, skipped: 0 };
    if (emitted.length > 0) {
      saveResult = await this.alertRepo.saveAlerts(
        emitted.map((a) => ({
          stockId: a.stockId,
          kind: a.kind,
          levelKey: a.levelKey,
          evaluatedDate: a.evaluatedDate,
          severity: a.severity,
          title: a.title,
          payload: a.payload,
        })),
      );
    }

    // 8. Record detected event flags for large moves and corporate data events
    for (const alert of emitted) {
      if (alert.kind === "LARGE_MOVE") {
        await this.eventFlagRepo.saveDetectedEvent({
          stockId: stock.id,
          kind: "LARGE_MOVE_DAY",
          eventDate: evaluationDate,
          headline: alert.title,
          detail: {
            key: "LARGE_MOVE",
            returnPct: alert.payload.returnPct,
            atrPercent: alert.payload.atrPercent,
          },
        });
      } else if (alert.kind === "DATA_EVENT") {
        await this.eventFlagRepo.saveDetectedEvent({
          stockId: stock.id,
          kind: "CORPORATE_ACTION",
          eventDate: evaluationDate,
          headline: alert.title,
          detail: {
            key: (alert.payload.subtype as string) ?? "DEMERGER_40PCT",
            returnPct: alert.payload.returnPct,
            note: "Possible corporate action",
          },
        });
      }
    }

    result.evaluated = true;
    result.alertsEmitted = emitted.length;
    result.alertsInserted = saveResult.inserted;
    result.alertsSkipped = saveResult.skipped;
    result.alerts = emitted;

    return result;
  }

  /**
   * Handles an active stock that stored NO bar on an active trading day.
   * Throttles DATA_HEALTH notice: emits UNHEALTHY_ENTER on first missing day,
   * single UNHEALTHY_REPEAT after >= 5 days, then suppresses.
   */
  private async handleMissingBarStock(
    stock: WatchlistStockRecord,
    evalDate: string,
  ): Promise<StockAlertEvaluationResult> {
    // Gate E1: Idempotency guard for same-day re-runs
    const existingToday = await this.alertRepo.getAlerts({
      stockId: stock.id,
      evaluatedDate: evalDate,
    });
    if (existingToday.some((a) => a.kind === "DATA_HEALTH")) {
      return {
        stockId: stock.id,
        symbol: stock.symbol,
        evaluatedDate: evalDate,
        evaluated: false,
        alertsEmitted: 0,
        alertsInserted: 0,
        alertsSkipped: 1,
        alerts: [],
        reason: `Missing price bar on trading day ${evalDate} (already evaluated today)`,
      };
    }

    const recentAlerts = await this.alertRepo.getRecentAlertsForStock(stock.id, {
      asOfDate: evalDate,
      lookbackCalendarDays: 30,
    });

    const recentHealthAlerts = recentAlerts
      .filter((a) => a.kind === "DATA_HEALTH")
      .sort((a, b) => b.evaluatedDate.localeCompare(a.evaluatedDate));
    const lastHealthAlert = recentHealthAlerts[0] ?? null;
    const lastHealthSubtype = lastHealthAlert?.payload?.subtype;

    const diffDays = lastHealthAlert
      ? Math.floor(
          (new Date(`${evalDate}T00:00:00Z`).getTime() -
            new Date(`${lastHealthAlert.evaluatedDate}T00:00:00Z`).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : 999;

    let shouldEmit = false;
    let subtype: "UNHEALTHY_ENTER" | "UNHEALTHY_REPEAT" = "UNHEALTHY_ENTER";

    if (!lastHealthAlert || lastHealthSubtype === "RECOVERED") {
      shouldEmit = true;
      subtype = "UNHEALTHY_ENTER";
    } else if (lastHealthSubtype === "UNHEALTHY_ENTER" && diffDays >= 5) {
      shouldEmit = true;
      subtype = "UNHEALTHY_REPEAT";
    }

    if (!shouldEmit) {
      return {
        stockId: stock.id,
        symbol: stock.symbol,
        evaluatedDate: evalDate,
        evaluated: false,
        alertsEmitted: 0,
        alertsInserted: 0,
        alertsSkipped: 0,
        alerts: [],
        reason: `Missing price bar on trading day ${evalDate} (throttled)`,
      };
    }

    const title =
      subtype === "UNHEALTHY_ENTER"
        ? `Data health notice: Entering unhealthy state - Missing price bar on trading day ${evalDate}.`
        : `Data health notice: Persisting unhealthy state (reminder) - Missing price bar on trading day ${evalDate}.`;

    const alert: EvaluatedAlert = {
      stockId: stock.id,
      kind: "DATA_HEALTH",
      levelKey: null,
      evaluatedDate: evalDate,
      severity: "NOTICE",
      title,
      payload: {
        close: 0,
        evaluatedDate: evalDate,
        seriesVersion: stock.series_version ?? 1,
        rulesHash: EQUITY_ALERT_RULES_HASH,
        disclaimer: EQUITY_ALERT_FOOTER,
        reason: `Missing price bar on trading day ${evalDate}.`,
        subtype,
      },
    };

    const saveResult = await this.alertRepo.saveAlerts([alert]);

    return {
      stockId: stock.id,
      symbol: stock.symbol,
      evaluatedDate: evalDate,
      evaluated: true,
      alertsEmitted: 1,
      alertsInserted: saveResult.inserted,
      alertsSkipped: saveResult.skipped,
      alerts: [alert],
      reason: `Missing price bar on trading day ${evalDate}`,
    };
  }

  /**
   * Runs End-of-Day alert evaluation across all active watchlist stocks for the given date.
   * If evaluationDate is omitted, uses current IST date.
   * Gates satisfied:
   * - E12: Weekends and market holidays produce 0 evaluation and 0 alerts.
   * - When at least one active stock stored a bar on evalDate, stocks without a bar get a DATA_HEALTH notice.
   * - Evaluation errors are persisted as DATA_HEALTH items into equity_research.alert.
   */
  async evaluateAll(
    evaluationDate?: string,
    options?: { symbol?: string; exchange?: "NSE" | "BSE" },
  ): Promise<AlertEvaluationSummary> {
    const evalDate = evaluationDate ?? formatIstDateString(new Date());

    // Gate E12: Weekend guard (Saturday = 6, Sunday = 0)
    const dateObj = new Date(`${evalDate}T00:00:00Z`);
    const dayOfWeek = dateObj.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return {
        evaluationDate: evalDate,
        totalStocks: 0,
        stocksEvaluated: 0,
        stocksSkipped: 0,
        totalAlertsEmitted: 0,
        totalAlertsInserted: 0,
        totalAlertsSkipped: 0,
        results: [],
        message: `Weekend date (${evalDate}) has no trading session; zero alerts evaluated (Gate E12)`,
      };
    }

    let stocks = await this.watchlistRepo.findActiveStocks();
    if (options?.symbol) {
      stocks = stocks.filter((s) => s.symbol === options.symbol);
      if (options.exchange) {
        stocks = stocks.filter((s) => s.exchange === options.exchange);
      }
    }

    if (stocks.length === 0) {
      return {
        evaluationDate: evalDate,
        totalStocks: 0,
        stocksEvaluated: 0,
        stocksSkipped: 0,
        totalAlertsEmitted: 0,
        totalAlertsInserted: 0,
        totalAlertsSkipped: 0,
        results: [],
      };
    }

    // Check if ANY bar exists on evalDate across all stocks (market holiday / non-trading day check)
    const isTradingDay = await this.priceBarRepo.hasAnyBarOnDate(evalDate);
    if (!isTradingDay) {
      return {
        evaluationDate: evalDate,
        totalStocks: stocks.length,
        stocksEvaluated: 0,
        stocksSkipped: stocks.length,
        totalAlertsEmitted: 0,
        totalAlertsInserted: 0,
        totalAlertsSkipped: 0,
        results: [],
        message: `No bars stored for any stock on ${evalDate} (market holiday / non-trading day); zero alerts evaluated (Gate E12)`,
      };
    }

    // At least one active stock traded: evalDate is a real trading day
    const results: StockAlertEvaluationResult[] = [];
    let stocksEvaluated = 0;
    let stocksSkipped = 0;
    let totalAlertsEmitted = 0;
    let totalAlertsInserted = 0;
    let totalAlertsSkipped = 0;

    for (const stock of stocks) {
      try {
        const res = await this.evaluateStock(stock, evalDate, { isTradingDay: true });
        results.push(res);
        if (res.evaluated) {
          stocksEvaluated++;
        } else {
          stocksSkipped++;
        }
        totalAlertsEmitted += res.alertsEmitted;
        totalAlertsInserted += res.alertsInserted;
        totalAlertsSkipped += res.alertsSkipped;
      } catch (err: unknown) {
        stocksSkipped++;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Persist evaluation error as a DATA_HEALTH item in database (Plan Section 7)
        try {
          const errAlert: EvaluatedAlert = {
            stockId: stock.id,
            kind: "DATA_HEALTH",
            levelKey: null,
            evaluatedDate: evalDate,
            severity: "NOTICE",
            title: `Data health notice: Entering unhealthy state - Evaluation error: ${errorMsg}`,
            payload: {
              close: 0,
              evaluatedDate: evalDate,
              seriesVersion: stock.series_version ?? 1,
              rulesHash: EQUITY_ALERT_RULES_HASH,
              disclaimer: EQUITY_ALERT_FOOTER,
              reason: `Evaluation error: ${errorMsg}`,
              subtype: "UNHEALTHY_ENTER",
            },
          };
          const saveRes = await this.alertRepo.saveAlerts([errAlert]);
          totalAlertsEmitted += 1;
          totalAlertsInserted += saveRes.inserted;
          totalAlertsSkipped += saveRes.skipped;
        } catch (saveErr) {
          console.error("Failed to persist evaluation error data health item:", saveErr);
        }

        results.push({
          stockId: stock.id,
          symbol: stock.symbol,
          evaluatedDate: evalDate,
          evaluated: false,
          alertsEmitted: 1,
          alertsInserted: 1,
          alertsSkipped: 0,
          alerts: [],
          reason: `Evaluation error: ${errorMsg}`,
        });
      }
    }

    return {
      evaluationDate: evalDate,
      totalStocks: stocks.length,
      stocksEvaluated,
      stocksSkipped,
      totalAlertsEmitted,
      totalAlertsInserted,
      totalAlertsSkipped,
      results,
    };
  }
}
