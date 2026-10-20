import {
  EQUITY_ALERT_FOOTER,
  EQUITY_ALERT_RULES_HASH,
  evaluateAlerts,
  type EvaluatedAlert,
} from "../domain/alert-rules.js";
import { computeLevels } from "../domain/levels.js";
import { formatIstDateString } from "../domain/state-rules.js";
import type { SecondaryFactRecord, WatchlistStockRecord } from "../domain/types.js";
import type { PostgresEquityAlertRepository } from "../infrastructure/repositories/postgres-equity-alert-repository.js";
import type { PostgresEquityCorporateActionRepository } from "../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import type { PostgresEquityEventFlagRepository } from "../infrastructure/repositories/postgres-equity-event-flag-repository.js";
import type { PostgresEquityPriceBarRepository } from "../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import type { PostgresEquitySecondaryFactRepository } from "../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import type { PostgresEquitySourceHealthRepository } from "../infrastructure/repositories/postgres-equity-source-health-repository.js";
import type { PostgresEquityWatchlistRepository } from "../infrastructure/repositories/postgres-equity-watchlist-repository.js";

function formatFactCurrency(value: number): string {
  const absVal = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absVal >= 1e7) {
    return `${sign}₹${(absVal / 1e7).toFixed(2)} Cr`;
  }
  return `${sign}₹${absVal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

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

export const ITEM_QUARTERLY_TOTAL_REVENUE = "quarterlyTotalRevenue";
export const ITEM_QUARTERLY_NET_INCOME = "quarterlyNetIncomeCommonStockholders";

export class EquityAlertsEvaluationService {
  private readonly holidays: Set<string>;
  private readonly secondaryFactRepo?: PostgresEquitySecondaryFactRepository;

  constructor(
    private readonly watchlistRepo: PostgresEquityWatchlistRepository,
    private readonly priceBarRepo: PostgresEquityPriceBarRepository,
    private readonly alertRepo: PostgresEquityAlertRepository,
    private readonly eventFlagRepo: PostgresEquityEventFlagRepository,
    private readonly sourceHealthRepo: PostgresEquitySourceHealthRepository,
    private readonly corporateActionRepo?: PostgresEquityCorporateActionRepository,
    secondaryFactRepoOrHolidays?: PostgresEquitySecondaryFactRepository | Set<string> | string[],
    holidays?: Set<string> | string[],
  ) {
    let passedHolidays: Set<string> | string[] | undefined;
    if (
      secondaryFactRepoOrHolidays instanceof Set ||
      Array.isArray(secondaryFactRepoOrHolidays)
    ) {
      passedHolidays = secondaryFactRepoOrHolidays;
      this.secondaryFactRepo = undefined;
    } else {
      this.secondaryFactRepo = secondaryFactRepoOrHolidays;
      passedHolidays = holidays;
    }

    const envHolidays = (process.env.NSE_HOLIDAYS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h));

    if (passedHolidays instanceof Set) {
      this.holidays = new Set([...passedHolidays, ...envHolidays]);
    } else if (Array.isArray(passedHolidays)) {
      this.holidays = new Set([...passedHolidays, ...envHolidays]);
    } else {
      this.holidays = new Set([...envHolidays]);
    }
  }

  /**
   * Checks whether the given date is an official exchange holiday.
   * Reads from passed holiday overrides / NSE_HOLIDAYS env, and queries
   * the persistent nse_holidays table (migrations 056 & 073).
   */
  async isHoliday(date: string): Promise<boolean> {
    if (this.holidays.has(date)) {
      return true;
    }
    if (typeof this.priceBarRepo?.isExchangeHoliday === "function") {
      return await this.priceBarRepo.isExchangeHoliday(date);
    }
    return false;
  }

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
      isInitialLoad?: boolean;
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

      // Check if evaluationDate is an exchange holiday from nse_holidays / NSE_HOLIDAYS
      if (await this.isHoliday(evaluationDate)) {
        result.reason = `Exchange holiday ${evaluationDate} (Gate E12)`;
        return result;
      }

      // Check if evaluationDate is an active trading day across the market
      const isTradingDay =
        options?.isTradingDay !== undefined
          ? options.isTradingDay
          : await this.priceBarRepo.hasAnyBarOnDate(evaluationDate);

      if (!isTradingDay) {
        // Zero bars stored across all stocks on non-holiday weekday = Outage
        return await this.handleMissingBarStock(stock, evaluationDate, true);
      }

      // It IS a trading day, but this active stock stored NO bar on evaluationDate!
      // This is an unhealthy-data event: emit throttled DATA_HEALTH alert.
      return await this.handleMissingBarStock(stock, evaluationDate, false);
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
    // (A) Stored SPLIT corporate action effective on evaluationDate (or in the weekend/holiday gap)
    const priorBarDate = bars.length > 1 ? bars[bars.length - 2].bar_date : undefined;
    const hasSplit =
      Boolean(options?.hasNewSplit) ||
      (this.corporateActionRepo
        ? await this.corporateActionRepo.hasSplitForDate(stock.id, evaluationDate, priorBarDate)
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

    // 8. Record detected event flags (Gate Step 5)
    // Guard against backfilled history: A newly added stock's initial backfill inserts all its
    // history; a flag must NEVER fire for backfilled history.
    const isInitialStockLoad =
      options?.isInitialLoad !== undefined
        ? options.isInitialLoad
        : ((stock.added_at instanceof Date
            ? stock.added_at.toISOString().split("T")[0]
            : String(stock.added_at).split("T")[0]) >= evaluationDate ||
          bars.length <= 1);

    // 8a. Large Move Day flags (from pure LARGE_MOVE alerts) & Demerger corporate actions
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
            note: "no note attached",
          },
        });
      } else if (alert.kind === "DATA_EVENT") {
        const subtype = (alert.payload.subtype as string) ?? "DEMERGER_40PCT";
        if (subtype === "DEMERGER_40PCT") {
          await this.eventFlagRepo.saveDetectedEvent({
            stockId: stock.id,
            kind: "CORPORATE_ACTION",
            eventDate: evaluationDate,
            headline: alert.title,
            detail: {
              key: "DEMERGER_40PCT",
              returnPct: alert.payload.returnPct,
              note: "Possible corporate action",
            },
          });
        }
      }
    }

    // 8b. Corporate Action flags (SPLIT / DIVIDEND in evaluation window)
    if (!isInitialStockLoad && this.corporateActionRepo) {
      const actions = priorBarDate
        ? await this.corporateActionRepo.getActionsInWindow(stock.id, priorBarDate, evaluationDate)
        : await this.corporateActionRepo.getActionsForDate(stock.id, evaluationDate);

      for (const action of actions) {
        let headline = "";
        if (action.kind === "DIVIDEND") {
          headline = `Dividend effective ${action.ex_date} (₹${Number(action.value).toFixed(2)} per share). No future announcements available from this source.`;
        } else if (action.kind === "SPLIT") {
          headline = `Stock split effective ${action.ex_date} (ratio ${Number(action.value)}). No future announcements available from this source.`;
        }

        if (headline) {
          await this.eventFlagRepo.saveDetectedEvent({
            stockId: stock.id,
            kind: "CORPORATE_ACTION",
            eventDate: action.ex_date,
            headline,
            detail: {
              key: `${action.kind}_${action.ex_date}`,
              actionKind: action.kind,
              value: Number(action.value),
              exDate: action.ex_date,
              source: action.source,
              note: "No future announcements available from this source.",
            },
          });
        }
      }
    }

    // 8c. Results Published flags (newly published quarterly results in secondary_fact)
    if (!isInitialStockLoad && this.secondaryFactRepo) {
      const newFacts = await this.secondaryFactRepo.getNewQuarterlyFacts(
        stock.id,
        evaluationDate,
        priorBarDate,
      );

      if (newFacts.length > 0) {
        const maxPriorPeriodEnd = await this.secondaryFactRepo.getMaxPriorQuarterPeriodEnd(
          stock.id,
          priorBarDate ?? evaluationDate,
        );

        if (maxPriorPeriodEnd !== null) {
          const factsByPeriod = new Map<string, SecondaryFactRecord[]>();
          for (const fact of newFacts) {
            const list = factsByPeriod.get(fact.period_end) ?? [];
            list.push(fact);
            factsByPeriod.set(fact.period_end, list);
          }

          for (const [newPeriodEnd, facts] of factsByPeriod.entries()) {
            if (newPeriodEnd > maxPriorPeriodEnd) {
              const revFact = facts.find((f) => f.item === ITEM_QUARTERLY_TOTAL_REVENUE);
              const netFact = facts.find((f) => f.item === ITEM_QUARTERLY_NET_INCOME);

              const [yStr, mStr, dStr] = newPeriodEnd.split("-");
              const priorYear = Number(yStr) - 1;
              const yoyTargetPeriodEnd = `${priorYear}-${mStr}-${dStr}`;

              const yoyFacts = await this.secondaryFactRepo.getFactsForPeriod(
                stock.id,
                yoyTargetPeriodEnd,
              );
              const priorRevFact = yoyFacts.find((f) => f.item === ITEM_QUARTERLY_TOTAL_REVENUE);
              const priorNetFact = yoyFacts.find((f) => f.item === ITEM_QUARTERLY_NET_INCOME);

              let revPart = "";
              let revYoYPct: number | null = null;
              if (revFact) {
                const val = Number(revFact.value);
                const valFormatted = formatFactCurrency(val);
                if (priorRevFact && Number(priorRevFact.value) !== 0) {
                  const pVal = Number(priorRevFact.value);
                  revYoYPct = ((val - pVal) / Math.abs(pVal)) * 100;
                  const sign = revYoYPct >= 0 ? "+" : "";
                  revPart = `Revenue ${valFormatted} (${sign}${revYoYPct.toFixed(1)}% YoY)`;
                } else {
                  revPart = `Revenue ${valFormatted}`;
                }
              }

              let netPart = "";
              let netYoYPct: number | null = null;
              if (netFact) {
                const val = Number(netFact.value);
                const valFormatted = formatFactCurrency(val);
                if (priorNetFact && Number(priorNetFact.value) !== 0) {
                  const pVal = Number(priorNetFact.value);
                  netYoYPct = ((val - pVal) / Math.abs(pVal)) * 100;
                  const sign = netYoYPct >= 0 ? "+" : "";
                  netPart = `Net income ${valFormatted} (${sign}${netYoYPct.toFixed(1)}% YoY)`;
                } else {
                  netPart = `Net income ${valFormatted}`;
                }
              }

              let summaryDetails = "";
              if (revPart && netPart) {
                summaryDetails = `: ${revPart}, ${netPart}.`;
              } else if (revPart) {
                summaryDetails = `: ${revPart}.`;
              } else if (netPart) {
                summaryDetails = `: ${netPart}.`;
              } else {
                summaryDetails = ".";
              }

              const headline = `Quarterly results published for period ending ${newPeriodEnd}${summaryDetails}`;

              await this.eventFlagRepo.saveDetectedEvent({
                stockId: stock.id,
                kind: "RESULTS_PUBLISHED",
                eventDate: evaluationDate,
                headline,
                detail: {
                  key: `RESULTS_${newPeriodEnd}`,
                  periodEnd: newPeriodEnd,
                  yoyPeriodEnd: yoyTargetPeriodEnd,
                  revenue: revFact ? Number(revFact.value) : null,
                  priorRevenue: priorRevFact ? Number(priorRevFact.value) : null,
                  revenueYoYPercent: revYoYPct !== null ? Number(revYoYPct.toFixed(2)) : null,
                  netIncome: netFact ? Number(netFact.value) : null,
                  priorNetIncome: priorNetFact ? Number(priorNetFact.value) : null,
                  netIncomeYoYPercent: netYoYPct !== null ? Number(netYoYPct.toFixed(2)) : null,
                },
              });
            }
          }
        }
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
   * Shared helper for emitting throttled DATA_HEALTH alerts (missing bar, evaluation error, outage).
   * Follows strict state machine:
   * - If already evaluated on evalDate: throttled (0 alerts).
   * - If no prior DATA_HEALTH or last was RECOVERED: emits UNHEALTHY_ENTER.
   * - If last was UNHEALTHY_ENTER and diffDays >= 5: emits UNHEALTHY_REPEAT (reminder).
   * - Otherwise: throttled (0 alerts).
   * Ensures:
   * - close carries lastKnownClose or null (never 0).
   * - rulesHash is EQUITY_ALERT_RULES_HASH (64-hex SHA-256).
   * - disclaimer is EQUITY_ALERT_FOOTER.
   * - alertsInserted reflects saveResult.inserted (never hardcoded).
   */
  private async emitThrottledHealthNotice(params: {
    stock: WatchlistStockRecord;
    evalDate: string;
    titleDetail: string;
    reason: string;
    lastKnownClose: number | null;
  }): Promise<{
    emitted: boolean;
    alert: EvaluatedAlert | null;
    inserted: number;
    skipped: number;
    reason: string;
  }> {
    const { stock, evalDate, titleDetail, reason, lastKnownClose } = params;

    // Gate E1: Idempotency guard for same-day re-runs
    const existingToday = await this.alertRepo.getAlerts({
      stockId: stock.id,
      evaluatedDate: evalDate,
    });
    if (existingToday.some((a) => a.kind === "DATA_HEALTH")) {
      return {
        emitted: false,
        alert: null,
        inserted: 0,
        skipped: 1,
        reason: `${reason} (already evaluated today)`,
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
        emitted: false,
        alert: null,
        inserted: 0,
        skipped: 0,
        reason: `${reason} (throttled)`,
      };
    }

    const title =
      subtype === "UNHEALTHY_ENTER"
        ? `Data health notice: Entering unhealthy state - ${titleDetail}.`
        : `Data health notice: Persisting unhealthy state (reminder) - ${titleDetail}.`;

    const alert: EvaluatedAlert = {
      stockId: stock.id,
      kind: "DATA_HEALTH",
      levelKey: null,
      evaluatedDate: evalDate,
      severity: "NOTICE",
      title,
      payload: {
        close: lastKnownClose,
        evaluatedDate: evalDate,
        seriesVersion: stock.series_version ?? 1,
        rulesHash: EQUITY_ALERT_RULES_HASH,
        disclaimer: EQUITY_ALERT_FOOTER,
        reason,
        subtype,
      },
    };

    const saveResult = await this.alertRepo.saveAlerts([alert]);

    return {
      emitted: true,
      alert,
      inserted: saveResult.inserted,
      skipped: saveResult.skipped,
      reason,
    };
  }

  /**
   * Handles an active stock that stored NO bar on an active trading day or during a market outage.
   */
  private async handleMissingBarStock(
    stock: WatchlistStockRecord,
    evalDate: string,
    isOutage = false,
  ): Promise<StockAlertEvaluationResult> {
    let lastKnownClose: number | null = null;
    try {
      const latestBars = await this.priceBarRepo.getBarsUpToDate(stock.id, evalDate, 1);
      lastKnownClose = latestBars.length > 0 ? latestBars[latestBars.length - 1].close : null;
    } catch {
      // ignore
    }

    const titleDetail = isOutage
      ? `Data source is unavailable (zero price bars stored on trading day ${evalDate})`
      : `Missing price bar on trading day ${evalDate}`;
    const reason = isOutage
      ? `Market data source is unavailable (zero price bars stored on trading day ${evalDate}).`
      : `Missing price bar on trading day ${evalDate}.`;

    const notice = await this.emitThrottledHealthNotice({
      stock,
      evalDate,
      titleDetail,
      reason,
      lastKnownClose,
    });

    return {
      stockId: stock.id,
      symbol: stock.symbol,
      evaluatedDate: evalDate,
      evaluated: notice.emitted,
      alertsEmitted: notice.emitted ? 1 : 0,
      alertsInserted: notice.inserted,
      alertsSkipped: notice.skipped,
      alerts: notice.alert ? [notice.alert] : [],
      reason: notice.reason,
    };
  }

  /**
   * Runs End-of-Day alert evaluation across all active watchlist stocks for the given date.
   * If evaluationDate is omitted, uses current IST date.
   * Gates satisfied:
   * - E12: Weekends and market holidays produce 0 evaluation and 0 alerts.
   * - Weekday outage (zero bars on non-holiday weekday): raises source-level data-health notice.
   * - When at least one active stock stored a bar on evalDate, stocks without a bar get a throttled DATA_HEALTH notice.
   * - Evaluation errors are persisted as throttled DATA_HEALTH items into equity_research.alert.
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

    // Check if ANY bar exists on evalDate across all stocks
    const isTradingDay = await this.priceBarRepo.hasAnyBarOnDate(evalDate);
    if (!isTradingDay) {
      // 1. Check if this date is a listed exchange holiday from nse_holidays / NSE_HOLIDAYS (Gate E12)
      if (await this.isHoliday(evalDate)) {
        return {
          evaluationDate: evalDate,
          totalStocks: stocks.length,
          stocksEvaluated: 0,
          stocksSkipped: stocks.length,
          totalAlertsEmitted: 0,
          totalAlertsInserted: 0,
          totalAlertsSkipped: 0,
          results: [],
          message: `Exchange holiday (${evalDate}); zero alerts evaluated (Gate E12)`,
        };
      }

      // 2. Evidence check (Condition 3): Check call log for successful chart calls on evalDate
      const hasSuccessfulCalls = await this.sourceHealthRepo.hasSuccessfulChartCallsOnDate(evalDate);
      if (hasSuccessfulCalls) {
        // Calls succeeded and no new bar arrived: treat it as a no-new-data day
        return {
          evaluationDate: evalDate,
          totalStocks: stocks.length,
          stocksEvaluated: 0,
          stocksSkipped: stocks.length,
          totalAlertsEmitted: 0,
          totalAlertsInserted: 0,
          totalAlertsSkipped: 0,
          results: [],
          message: `Calls succeeded with zero new bars on ${evalDate}; treated as no-new-data day`,
        };
      }

      // 3. Outage: Non-holiday weekday with zero bars AND zero successful chart calls in call log!
      await this.sourceHealthRepo.updateHealth({
        source: "YAHOO",
        endpoint: "chart",
        success: false,
        dateKey: evalDate,
        errorMessage: `Market outage detected: 0 bars stored and 0 successful calls on non-holiday weekday ${evalDate}`,
      });

      const outageResults: StockAlertEvaluationResult[] = [];
      let totalAlertsEmitted = 0;
      let totalAlertsInserted = 0;
      let totalAlertsSkipped = 0;
      let stocksEvaluated = 0;

      for (const stock of stocks) {
        let lastKnownClose: number | null = null;
        try {
          const latestBars = await this.priceBarRepo.getBarsUpToDate(stock.id, evalDate, 1);
          lastKnownClose = latestBars.length > 0 ? latestBars[latestBars.length - 1].close : null;
        } catch {
          // ignore
        }

        const notice = await this.emitThrottledHealthNotice({
          stock,
          evalDate,
          titleDetail: `Data source is unavailable (zero price bars stored on trading day ${evalDate})`,
          reason: `Market data source is unavailable (zero price bars stored on trading day ${evalDate}).`,
          lastKnownClose,
        });

        if (notice.emitted) {
          totalAlertsEmitted += 1;
          stocksEvaluated += 1;
        }
        totalAlertsInserted += notice.inserted;
        totalAlertsSkipped += notice.skipped;

        outageResults.push({
          stockId: stock.id,
          symbol: stock.symbol,
          evaluatedDate: evalDate,
          evaluated: notice.emitted,
          alertsEmitted: notice.emitted ? 1 : 0,
          alertsInserted: notice.inserted,
          alertsSkipped: notice.skipped,
          alerts: notice.alert ? [notice.alert] : [],
          reason: notice.reason,
        });
      }

      return {
        evaluationDate: evalDate,
        totalStocks: stocks.length,
        stocksEvaluated,
        stocksSkipped: stocks.length - stocksEvaluated,
        totalAlertsEmitted,
        totalAlertsInserted,
        totalAlertsSkipped,
        results: outageResults,
        message: `Market data source outage detected on ${evalDate}: zero bars stored on non-holiday weekday; raised data-health notices`,
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

        let lastKnownClose: number | null = null;
        try {
          const latestBars = await this.priceBarRepo.getBarsUpToDate(stock.id, evalDate, 1);
          lastKnownClose = latestBars.length > 0 ? latestBars[latestBars.length - 1].close : null;
        } catch {
          // ignore
        }

        const notice = await this.emitThrottledHealthNotice({
          stock,
          evalDate,
          titleDetail: `Evaluation error: ${errorMsg}`,
          reason: `Evaluation error: ${errorMsg}`,
          lastKnownClose,
        });

        if (notice.emitted) {
          totalAlertsEmitted += 1;
        }
        totalAlertsInserted += notice.inserted;
        totalAlertsSkipped += notice.skipped;

        results.push({
          stockId: stock.id,
          symbol: stock.symbol,
          evaluatedDate: evalDate,
          evaluated: notice.emitted,
          alertsEmitted: notice.emitted ? 1 : 0,
          alertsInserted: notice.inserted,
          alertsSkipped: notice.skipped,
          alerts: notice.alert ? [notice.alert] : [],
          reason: notice.reason,
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
