import {
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
   * - E6: Demerger / 40%+ move yields DATA_EVENT, never LARGE_MOVE.
   * - E12: If no bar exists on evaluationDate (weekend, holiday, missing bar), returns 0 alerts.
   * - E16: Passes recentAlerts containing the latest DATA_HEALTH alert regardless of age.
   */
  async evaluateStock(
    stock: WatchlistStockRecord,
    evaluationDate: string,
    options?: { isOldRestatement?: boolean; hasNewSplit?: boolean },
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

    if (!bars || bars.length === 0) {
      result.reason = "No bars found up to evaluation date";
      return result;
    }

    const lastBar = bars[bars.length - 1];

    // Gate E12: Only stocks that stored a bar on evaluationDate are evaluated
    if (lastBar.bar_date !== evaluationDate) {
      result.reason = `No bar stored on evaluation date ${evaluationDate} (last bar was ${lastBar.bar_date})`;
      return result;
    }

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

    // 6. Check for extra DATA_EVENT conditions (new split or older bar restatement)
    if (options?.hasNewSplit) {
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
          title: `Stock split effective on ${evaluationDate}: historical series re-scaled.`,
          payload: {
            close: lastBar.close,
            evaluatedDate: evaluationDate,
            subtype: "SPLIT",
            seriesVersion: stock.series_version ?? 1,
            rulesHash: levelsAtT.disclaimer ? "equity-alerts-v1" : "",
            disclaimer: levelsAtT.disclaimer,
          },
        });
      }
    }

    if (options?.isOldRestatement) {
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
            rulesHash: levelsAtT.disclaimer ? "equity-alerts-v1" : "",
            disclaimer: levelsAtT.disclaimer,
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
            key: (alert.payload.subtype as string) ?? "DATA_EVENT_DEMERGER",
            returnPct: alert.payload.returnPct,
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
   * Runs End-of-Day alert evaluation across all active watchlist stocks for the given date.
   * If evaluationDate is omitted, uses current IST date.
   * Gate E12: Weekends and market holidays produce 0 evaluation and 0 alerts.
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

    const results: StockAlertEvaluationResult[] = [];
    let stocksEvaluated = 0;
    let stocksSkipped = 0;
    let totalAlertsEmitted = 0;
    let totalAlertsInserted = 0;
    let totalAlertsSkipped = 0;

    for (const stock of stocks) {
      try {
        const res = await this.evaluateStock(stock, evalDate);
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
        results.push({
          stockId: stock.id,
          symbol: stock.symbol,
          evaluatedDate: evalDate,
          evaluated: false,
          alertsEmitted: 0,
          alertsInserted: 0,
          alertsSkipped: 0,
          alerts: [],
          reason: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`,
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
