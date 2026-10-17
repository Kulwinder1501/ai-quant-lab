/**
 * Equity Watch (Slice 1): Descriptive Trend Metrics Domain Logic
 *
 * Strict Architectural Rules (from slice 1 plan):
 * 1. Pure functions only: no database, no clock, no network calls.
 * 2. Strictly descriptive: "what happened", never "what to do" or "what will happen".
 * 3. Zero predictive outputs or sentiment: purely historical price and volume measurements.
 * 4. Raw close / price return on adjusted series only (dividends excluded).
 */

export type TrendMetricState = "OK" | "INSUFFICIENT_HISTORY" | "NOT_MEANINGFUL" | "SUSPENDED";

export interface TrendMetricValue {
  formulaId: string;
  formulaText: string;
  window: string;
  value: number | null;
  formatted: string;
  barsUsed: number;
  firstDateUsed: string | null;
  lastDateUsed: string | null;
  state: TrendMetricState;
  warnings: string[];
}

export interface LargeDailyMove {
  date: string;
  previousClose: number;
  close: number;
  percentChange: number;
}

export interface TrendMetricsInput {
  bars: Array<{
    bar_date: string; // YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  rebackfillNeeded: boolean;
  seriesVersion?: number;
  /** Current evaluation date (YYYY-MM-DD). If omitted, defaults to the last bar date T. */
  asOfEvaluationDate?: string;
}

export interface TrendSummary {
  return1M: number | null;
  return1Y: number | null;
  position52W: number | null;
  state: TrendMetricState;
  asOfDate?: string | null;
  isStale?: boolean;
}

export interface TrendPanelResult {
  asOfDate: string | null;
  isStale: boolean;
  staleDays: number;
  rebackfillNeeded: boolean;
  seriesVersion: number;
  metrics: {
    latestClose: TrendMetricValue;
    return1M: TrendMetricValue;
    return3M: TrendMetricValue;
    return6M: TrendMetricValue;
    returnYTD: TrendMetricValue;
    return1Y: TrendMetricValue;
    sma50: TrendMetricValue;
    sma200: TrendMetricValue;
    distanceFromSma50: TrendMetricValue;
    distanceFromSma200: TrendMetricValue;
    sma50VsSma200: TrendMetricValue;
    high52W: TrendMetricValue;
    low52W: TrendMetricValue;
    position52W: TrendMetricValue;
    distanceFrom52WHigh: TrendMetricValue;
    volatility20D: TrendMetricValue;
    volatility1Y: TrendMetricValue;
    maxDrawdown1Y: TrendMetricValue;
    relativeActivity: TrendMetricValue;
    largeDailyMovesCount: TrendMetricValue;
  };
  largeDailyMoves: LargeDailyMove[];
  trendSummary: TrendSummary;
  disclaimer: string;
  warnings: string[];
}

export const EQUITY_TREND_DISCLAIMER =
  "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.";

// ==========================================
// Date & Calendar Math Helpers
// ==========================================

export function getTodayIstDate(now: Date = new Date()): string {
  // IST is UTC+05:30 -> offset in ms is 5.5 * 3600 * 1000 = 19,800,000 ms
  const istTime = new Date(now.getTime() + 19_800_000);
  return istTime.toISOString().slice(0, 10);
}

export function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid date string '${dateStr}'. Expected YYYY-MM-DD format.`);
  }
  return { year: y, month: m, day: d };
}

export function formatDateParts(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calculates calendar day difference between two YYYY-MM-DD dates (|dateA - dateB|).
 */
export function calendarDaysDifference(dateA: string, dateB: string): number {
  const pA = parseDateParts(dateA);
  const pB = parseDateParts(dateB);
  const utcA = Date.UTC(pA.year, pA.month - 1, pA.day);
  const utcB = Date.UTC(pB.year, pB.month - 1, pB.day);
  return Math.round(Math.abs(utcA - utcB) / (86_400 * 1_000));
}

/**
 * Subtracts N calendar months from a date (YYYY-MM-DD).
 * Clamps day to the maximum days in the destination month (e.g. 31 May - 3 months = 28 Feb).
 */
export function subtractCalendarMonths(dateStr: string, months: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  let destYear = year;
  let destMonth = month - months;
  while (destMonth <= 0) {
    destMonth += 12;
    destYear -= 1;
  }
  const maxDay = getDaysInMonth(destYear, destMonth);
  const destDay = Math.min(day, maxDay);
  return formatDateParts(destYear, destMonth, destDay);
}

/**
 * Subtracts N calendar days from a date (YYYY-MM-DD).
 */
export function subtractCalendarDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const utc = Date.UTC(year, month - 1, day) - days * 86_400 * 1_000;
  const d = new Date(utc);
  return formatDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Computes calendar days between a reference calendar date and an actual historical bar date: referenceDate - barDate.
 */
export function calendarDaysPrior(referenceDate: string, barDate: string): number {
  const pRef = parseDateParts(referenceDate);
  const pBar = parseDateParts(barDate);
  const utcRef = Date.UTC(pRef.year, pRef.month - 1, pRef.day);
  const utcBar = Date.UTC(pBar.year, pBar.month - 1, pBar.day);
  return Math.round((utcRef - utcBar) / (86_400 * 1_000));
}

function checkWindowGaps(
  bars: Array<{ bar_date: string }>,
  maxAllowedGapDays = 10,
): string[] {
  const warnings: string[] = [];
  for (let i = 1; i < bars.length; i++) {
    const diff = calendarDaysDifference(bars[i - 1].bar_date, bars[i].bar_date);
    if (diff > maxAllowedGapDays) {
      warnings.push(
        `Contains a gap of ${diff} calendar days between ${bars[i - 1].bar_date} and ${bars[i].bar_date}.`,
      );
    }
  }
  return warnings;
}

function formatPercent(val: number | null, decimals = 2): string {
  if (val === null || !Number.isFinite(val)) return "-";
  const pct = (val * 100).toFixed(decimals);
  return val > 0 ? `+${pct}%` : `${pct}%`;
}

function formatNumber(val: number | null, decimals = 2): string {
  if (val === null || !Number.isFinite(val)) return "-";
  return val.toFixed(decimals);
}

// ==========================================
// Metric Calculations
// ==========================================

export function computeTrendPanel(input: TrendMetricsInput): TrendPanelResult {
  const rebackfillNeeded = Boolean(input.rebackfillNeeded);
  const seriesVersion = input.seriesVersion ?? 1;

  // Filter and sort bars ascending by date
  const rawBars = input.bars || [];
  const globalWarnings: string[] = [];

  const validBars = rawBars
    .filter((b) => {
      const isValid =
        typeof b.close === "number" &&
        Number.isFinite(b.close) &&
        b.close > 0 &&
        typeof b.bar_date === "string" &&
        b.bar_date.length === 10;
      if (!isValid) {
        globalWarnings.push(`Excluded invalid or non-positive bar at date '${b.bar_date}'.`);
      }
      return isValid;
    })
    .sort((a, b) => a.bar_date.localeCompare(b.bar_date));

  const totalBars = validBars.length;
  const lastBar = totalBars > 0 ? validBars[totalBars - 1] : null;
  const asOfDate = lastBar?.bar_date ?? null;

  // Staleness evaluation
  let isStale = false;
  let staleDays = 0;
  if (asOfDate) {
    const evalDate = input.asOfEvaluationDate || asOfDate;
    staleDays = calendarDaysPrior(evalDate, asOfDate);
    if (staleDays > 4) {
      isStale = true;
      globalWarnings.push(`Price data is as of ${asOfDate} (${staleDays} calendar days ago).`);
    }
  }

  // Helper for suspended metric
  const makeSuspended = (
    formulaId: string,
    formulaText: string,
    window: string,
  ): TrendMetricValue => ({
    formulaId,
    formulaText,
    window,
    value: null,
    formatted: "-",
    barsUsed: 0,
    firstDateUsed: null,
    lastDateUsed: asOfDate,
    state: "SUSPENDED",
    warnings: ["Corporate action or restatement detected; full series is being re-synchronised."],
  });

  if (rebackfillNeeded) {
    const suspendedPanel: TrendPanelResult = {
      asOfDate,
      isStale,
      staleDays,
      rebackfillNeeded: true,
      seriesVersion,
      metrics: {
        latestClose: makeSuspended("latest_close", "close(T)", "1 bar"),
        return1M: makeSuspended("return_1m", "close(T) / close(ref) - 1 (1 calendar month)", "1 calendar month"),
        return3M: makeSuspended("return_3m", "close(T) / close(ref) - 1 (3 calendar months)", "3 calendar months"),
        return6M: makeSuspended("return_6m", "close(T) / close(ref) - 1 (6 calendar months)", "6 calendar months"),
        returnYTD: makeSuspended("return_ytd", "close(T) / close(ref) - 1 (from 31 Dec previous year)", "Year-to-date"),
        return1Y: makeSuspended("return_1y", "close(T) / close(ref) - 1 (1 calendar year)", "1 calendar year"),
        sma50: makeSuspended("sma_50", "mean(close) over last 50 trading days", "50 trading days"),
        sma200: makeSuspended("sma_200", "mean(close) over last 200 trading days", "200 trading days"),
        distanceFromSma50: makeSuspended("dist_sma_50", "close(T) / SMA(50) - 1", "50 trading days"),
        distanceFromSma200: makeSuspended("dist_sma_200", "close(T) / SMA(200) - 1", "200 trading days"),
        sma50VsSma200: makeSuspended("sma_50_vs_200", "SMA(50) / SMA(200) - 1", "200 trading days"),
        high52W: makeSuspended("high_52w", "max(high) over bars with date > T - 365 days", "365 calendar days"),
        low52W: makeSuspended("low_52w", "min(low) over bars with date > T - 365 days", "365 calendar days"),
        position52W: makeSuspended("position_52w", "(close(T) - low) / (high - low)", "365 calendar days"),
        distanceFrom52WHigh: makeSuspended("dist_high_52w", "close(T) / high - 1", "365 calendar days"),
        volatility20D: makeSuspended("volatility_20d", "std(ln(c_t / c_{t-1})) * sqrt(252) over 20 daily returns", "20 trading days"),
        volatility1Y: makeSuspended("volatility_1y", "std(ln(c_t / c_{t-1})) * sqrt(252) over 252 daily returns", "252 trading days"),
        maxDrawdown1Y: makeSuspended("max_dd_1y", "min(close_t / running_max_close - 1) over last 365 calendar days", "365 calendar days"),
        relativeActivity: makeSuspended("relative_activity", "mean(volume_20) / mean(volume_252)", "252 trading days"),
        largeDailyMovesCount: makeSuspended("large_moves_count", "count of days with |c_t / c_{t-1} - 1| > 20% in last 252 daily returns", "252 trading days"),
      },
      largeDailyMoves: [],
      trendSummary: {
        return1M: null,
        return1Y: null,
        position52W: null,
        state: "SUSPENDED",
      },
      disclaimer: EQUITY_TREND_DISCLAIMER,
      warnings: ["Corporate action or restatement detected; full series is being re-synchronised."],
    };
    return suspendedPanel;
  }

  // 1. Latest Close
  let latestClose: TrendMetricValue;
  if (!lastBar) {
    latestClose = {
      formulaId: "latest_close",
      formulaText: "close(T)",
      window: "1 bar",
      value: null,
      formatted: "-",
      barsUsed: 0,
      firstDateUsed: null,
      lastDateUsed: null,
      state: "INSUFFICIENT_HISTORY",
      warnings: ["No valid price bars available."],
    };
  } else {
    latestClose = {
      formulaId: "latest_close",
      formulaText: "close(T)",
      window: "1 bar",
      value: lastBar.close,
      formatted: formatNumber(lastBar.close),
      barsUsed: 1,
      firstDateUsed: lastBar.bar_date,
      lastDateUsed: lastBar.bar_date,
      state: "OK",
      warnings: [],
    };
  }

  // Helper for horizon returns (1M, 3M, 6M, 1Y)
  const computeHorizonReturn = (
    formulaId: string,
    horizonMonths: number,
    windowLabel: string,
  ): TrendMetricValue => {
    const formulaText = `close(T) / close(ref) - 1 (${windowLabel})`;
    if (!lastBar || totalBars === 0) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: ["No bars available to compute return."],
      };
    }

    const referenceDate = subtractCalendarMonths(lastBar.bar_date, horizonMonths);
    // Find latest bar with bar_date <= referenceDate
    let refIdx = -1;
    for (let i = totalBars - 1; i >= 0; i--) {
      if (validBars[i].bar_date <= referenceDate) {
        refIdx = i;
        break;
      }
    }

    if (refIdx === -1) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [`No historical bar on or before reference date ${referenceDate}.`],
      };
    }

    const refBar = validBars[refIdx];
    const daysApart = calendarDaysPrior(referenceDate, refBar.bar_date);
    if (daysApart > 5) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [
          `Nearest historical bar (${refBar.bar_date}) is ${daysApart} calendar days before reference date ${referenceDate} (maximum allowed is 5 days).`,
        ],
      };
    }

    const barsWindow = validBars.slice(refIdx);
    const warnings = checkWindowGaps(barsWindow);
    const ret = lastBar.close / refBar.close - 1;

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: ret,
      formatted: formatPercent(ret),
      barsUsed: barsWindow.length,
      firstDateUsed: refBar.bar_date,
      lastDateUsed: lastBar.bar_date,
      state: "OK",
      warnings,
    };
  };

  // Helper for YTD Return
  const computeYtdReturn = (): TrendMetricValue => {
    const formulaId = "return_ytd";
    const formulaText = "close(T) / close(ref) - 1 (from 31 Dec of previous year)";
    const windowLabel = "Year-to-date";

    if (!lastBar || totalBars === 0) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: ["No bars available to compute YTD return."],
      };
    }

    const { year } = parseDateParts(lastBar.bar_date);
    const referenceDate = `${year - 1}-12-31`;

    let refIdx = -1;
    for (let i = totalBars - 1; i >= 0; i--) {
      if (validBars[i].bar_date <= referenceDate) {
        refIdx = i;
        break;
      }
    }

    if (refIdx === -1) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [`No historical bar on or before year-end reference date ${referenceDate}.`],
      };
    }

    const refBar = validBars[refIdx];
    const daysApart = calendarDaysPrior(referenceDate, refBar.bar_date);
    if (daysApart > 5) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [
          `Nearest historical bar (${refBar.bar_date}) is ${daysApart} calendar days before year-end reference date ${referenceDate} (maximum allowed is 5 days).`,
        ],
      };
    }

    const barsWindow = validBars.slice(refIdx);
    const warnings = checkWindowGaps(barsWindow);
    const ret = lastBar.close / refBar.close - 1;

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: ret,
      formatted: formatPercent(ret),
      barsUsed: barsWindow.length,
      firstDateUsed: refBar.bar_date,
      lastDateUsed: lastBar.bar_date,
      state: "OK",
      warnings,
    };
  };

  const return1M = computeHorizonReturn("return_1m", 1, "1 calendar month");
  const return3M = computeHorizonReturn("return_3m", 3, "3 calendar months");
  const return6M = computeHorizonReturn("return_6m", 6, "6 calendar months");
  const returnYTD = computeYtdReturn();
  const return1Y = computeHorizonReturn("return_1y", 12, "1 calendar year");

  // Helper for Simple Moving Average (SMA)
  const computeSma = (
    formulaId: string,
    period: number,
  ): TrendMetricValue => {
    const formulaText = `mean(close) over last ${period} trading days`;
    const windowLabel = `${period} trading days`;

    if (totalBars < period) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: totalBars,
        firstDateUsed: validBars[0]?.bar_date ?? null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [`Requires at least ${period} trading days of history; ${totalBars} available.`],
      };
    }

    const windowBars = validBars.slice(totalBars - period);
    const warnings = checkWindowGaps(windowBars);
    const sum = windowBars.reduce((acc, b) => acc + b.close, 0);
    const sma = sum / period;

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: sma,
      formatted: formatNumber(sma),
      barsUsed: period,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[period - 1].bar_date,
      state: "OK",
      warnings,
    };
  };

  const sma50 = computeSma("sma_50", 50);
  const sma200 = computeSma("sma_200", 200);

  // Distance from SMA
  const computeDistanceFromSma = (
    formulaId: string,
    smaMetric: TrendMetricValue,
    period: number,
  ): TrendMetricValue => {
    const formulaText = `close(T) / SMA(${period}) - 1`;
    const windowLabel = `${period} trading days`;

    if (smaMetric.state !== "OK" || smaMetric.value === null || !lastBar) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: smaMetric.barsUsed,
        firstDateUsed: smaMetric.firstDateUsed,
        lastDateUsed: smaMetric.lastDateUsed,
        state: "INSUFFICIENT_HISTORY",
        warnings: smaMetric.warnings,
      };
    }

    const dist = lastBar.close / smaMetric.value - 1;
    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: dist,
      formatted: formatPercent(dist),
      barsUsed: smaMetric.barsUsed,
      firstDateUsed: smaMetric.firstDateUsed,
      lastDateUsed: smaMetric.lastDateUsed,
      state: "OK",
      warnings: smaMetric.warnings,
    };
  };

  const distanceFromSma50 = computeDistanceFromSma("dist_sma_50", sma50, 50);
  const distanceFromSma200 = computeDistanceFromSma("dist_sma_200", sma200, 200);

  // 50-day vs 200-day average ratio
  const computeSma50Vs200 = (): TrendMetricValue => {
    const formulaId = "sma_50_vs_200";
    const formulaText = "SMA(50) / SMA(200) - 1";
    const windowLabel = "200 trading days";

    if (sma50.state !== "OK" || sma200.state !== "OK" || sma50.value === null || sma200.value === null) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: Math.max(sma50.barsUsed, sma200.barsUsed),
        firstDateUsed: sma200.firstDateUsed,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: ["Both 50-day and 200-day averages are required."],
      };
    }

    const diff = sma50.value / sma200.value - 1;
    const pct = Math.abs(diff * 100).toFixed(2);
    let comparisonText = `50-day average is equal to 200-day average`;
    if (diff > 0) {
      comparisonText = `50-day average is ${pct}% above 200-day average`;
    } else if (diff < 0) {
      comparisonText = `50-day average is ${pct}% below 200-day average`;
    }

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: diff,
      formatted: comparisonText,
      barsUsed: 200,
      firstDateUsed: sma200.firstDateUsed,
      lastDateUsed: asOfDate,
      state: "OK",
      warnings: [...sma50.warnings, ...sma200.warnings],
    };
  };

  const sma50VsSma200 = computeSma50Vs200();

  // 52-Week Range metrics
  const compute52WeekMetrics = (): {
    high52W: TrendMetricValue;
    low52W: TrendMetricValue;
    position52W: TrendMetricValue;
    distanceFrom52WHigh: TrendMetricValue;
  } => {
    const windowLabel = "365 calendar days";
    if (!lastBar || totalBars === 0) {
      const emptyMetric = (formulaId: string, formulaText: string): TrendMetricValue => ({
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: ["No bars available."],
      });
      return {
        high52W: emptyMetric("high_52w", "max(high) over bars with date > T - 365 days"),
        low52W: emptyMetric("low_52w", "min(low) over bars with date > T - 365 days"),
        position52W: emptyMetric("position_52w", "(close(T) - low) / (high - low)"),
        distanceFrom52WHigh: emptyMetric("dist_high_52w", "close(T) / high - 1"),
      };
    }

    const cutoffDate = subtractCalendarDays(lastBar.bar_date, 365);
    // Bars strictly with date > T - 365 days
    const windowBars = validBars.filter((b) => b.bar_date > cutoffDate);

    if (windowBars.length < 200) {
      const insufficientMetric = (formulaId: string, formulaText: string): TrendMetricValue => ({
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: windowBars.length,
        firstDateUsed: windowBars[0]?.bar_date ?? null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [
          `Requires at least 200 trading days in the 52-week window; ${windowBars.length} available.`,
        ],
      });
      return {
        high52W: insufficientMetric("high_52w", "max(high) over bars with date > T - 365 days"),
        low52W: insufficientMetric("low_52w", "min(low) over bars with date > T - 365 days"),
        position52W: insufficientMetric("position_52w", "(close(T) - low) / (high - low)"),
        distanceFrom52WHigh: insufficientMetric("dist_high_52w", "close(T) / high - 1"),
      };
    }

    const warnings = checkWindowGaps(windowBars);
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (const b of windowBars) {
      if (b.high > maxHigh) maxHigh = b.high;
      if (b.low < minLow) minLow = b.low;
    }

    const high52W: TrendMetricValue = {
      formulaId: "high_52w",
      formulaText: "max(high) over bars with date > T - 365 days",
      window: windowLabel,
      value: maxHigh,
      formatted: formatNumber(maxHigh),
      barsUsed: windowBars.length,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[windowBars.length - 1].bar_date,
      state: "OK",
      warnings,
    };

    const low52W: TrendMetricValue = {
      formulaId: "low_52w",
      formulaText: "min(low) over bars with date > T - 365 days",
      window: windowLabel,
      value: minLow,
      formatted: formatNumber(minLow),
      barsUsed: windowBars.length,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[windowBars.length - 1].bar_date,
      state: "OK",
      warnings,
    };

    // Position in 52-week range: (close - low) / (high - low)
    let position52W: TrendMetricValue;
    if (maxHigh === minLow) {
      position52W = {
        formulaId: "position_52w",
        formulaText: "(close(T) - low) / (high - low)",
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: windowBars.length,
        firstDateUsed: windowBars[0].bar_date,
        lastDateUsed: windowBars[windowBars.length - 1].bar_date,
        state: "NOT_MEANINGFUL",
        warnings: ["52-week high equals 52-week low."],
      };
    } else {
      const pos = (lastBar.close - minLow) / (maxHigh - minLow);
      position52W = {
        formulaId: "position_52w",
        formulaText: "(close(T) - low) / (high - low)",
        window: windowLabel,
        value: pos,
        formatted: `${(pos * 100).toFixed(1)}%`,
        barsUsed: windowBars.length,
        firstDateUsed: windowBars[0].bar_date,
        lastDateUsed: windowBars[windowBars.length - 1].bar_date,
        state: "OK",
        warnings,
      };
    }

    const distHigh = lastBar.close / maxHigh - 1;
    const distanceFrom52WHigh: TrendMetricValue = {
      formulaId: "dist_high_52w",
      formulaText: "close(T) / high - 1",
      window: windowLabel,
      value: distHigh,
      formatted: formatPercent(distHigh),
      barsUsed: windowBars.length,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[windowBars.length - 1].bar_date,
      state: "OK",
      warnings,
    };

    return { high52W, low52W, position52W, distanceFrom52WHigh };
  };

  const { high52W, low52W, position52W, distanceFrom52WHigh } = compute52WeekMetrics();

  // Volatility (sample standard deviation of daily logarithmic returns, annualised * sqrt(252))
  const computeVolatility = (
    formulaId: string,
    returnsCount: number,
  ): TrendMetricValue => {
    const requiredBars = returnsCount + 1;
    const windowLabel = `${returnsCount} trading days`;
    const formulaText = `std(ln(c_t / c_{t-1})) * sqrt(252) over ${returnsCount} daily returns`;

    if (totalBars < requiredBars) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: totalBars,
        firstDateUsed: validBars[0]?.bar_date ?? null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [
          `Requires at least ${requiredBars} trading days (${returnsCount} returns); ${totalBars} available.`,
        ],
      };
    }

    const windowBars = validBars.slice(totalBars - requiredBars);
    const warnings = checkWindowGaps(windowBars);

    // Compute log returns
    const logReturns: number[] = [];
    for (let i = 1; i < windowBars.length; i++) {
      const r = Math.log(windowBars[i].close / windowBars[i - 1].close);
      logReturns.push(r);
    }

    const mean = logReturns.reduce((acc, r) => acc + r, 0) / logReturns.length;
    let sumSquaredDiff = 0;
    for (const r of logReturns) {
      sumSquaredDiff += (r - mean) ** 2;
    }

    // Sample std dev has denominator n - 1
    const sampleVariance = sumSquaredDiff / (logReturns.length - 1);
    const sampleStd = Math.sqrt(sampleVariance);
    const annualisedVol = sampleStd * Math.sqrt(252);

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: annualisedVol,
      formatted: `${(annualisedVol * 100).toFixed(1)}%`,
      barsUsed: requiredBars,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[windowBars.length - 1].bar_date,
      state: "OK",
      warnings,
    };
  };

  const volatility20D = computeVolatility("volatility_20d", 20);
  const volatility1Y = computeVolatility("volatility_1y", 252);

  // Maximum Drawdown (1-year, over bars with date > T - 365 days, min 200 bars)
  const computeMaxDrawdown1Y = (): TrendMetricValue => {
    const formulaId = "max_dd_1y";
    const formulaText = "min(close_t / running_max_close - 1) over last 365 calendar days";
    const windowLabel = "365 calendar days";

    if (!lastBar || totalBars === 0) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 0,
        firstDateUsed: null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: ["No bars available."],
      };
    }

    const cutoffDate = subtractCalendarDays(lastBar.bar_date, 365);
    const windowBars = validBars.filter((b) => b.bar_date > cutoffDate);

    if (windowBars.length < 200) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: windowBars.length,
        firstDateUsed: windowBars[0]?.bar_date ?? null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [
          `Requires at least 200 trading days in the 52-week window; ${windowBars.length} available.`,
        ],
      };
    }

    const warnings = checkWindowGaps(windowBars);
    let runningMax = -Infinity;
    let maxDrawdown = 0; // 0 or negative

    for (const b of windowBars) {
      if (b.close > runningMax) {
        runningMax = b.close;
      }
      const dd = b.close / runningMax - 1;
      if (dd < maxDrawdown) {
        maxDrawdown = dd;
      }
    }

    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: maxDrawdown,
      formatted: formatPercent(maxDrawdown),
      barsUsed: windowBars.length,
      firstDateUsed: windowBars[0].bar_date,
      lastDateUsed: windowBars[windowBars.length - 1].bar_date,
      state: "OK",
      warnings,
    };
  };

  const maxDrawdown1Y = computeMaxDrawdown1Y();

  // Relative Activity: mean volume(20) / mean volume(252)
  const computeRelativeActivity = (): TrendMetricValue => {
    const formulaId = "relative_activity";
    const formulaText = "mean(volume_20) / mean(volume_252)";
    const windowLabel = "252 trading days";

    if (totalBars < 252) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: totalBars,
        firstDateUsed: validBars[0]?.bar_date ?? null,
        lastDateUsed: asOfDate,
        state: "INSUFFICIENT_HISTORY",
        warnings: [`Requires at least 252 trading days; ${totalBars} available.`],
      };
    }

    const windowBars252 = validBars.slice(totalBars - 252);
    const windowBars20 = validBars.slice(totalBars - 20);
    const warnings = checkWindowGaps(windowBars252);
    warnings.push("Latest day volume is preliminary.");

    const sumVol252 = windowBars252.reduce((acc, b) => acc + (b.volume || 0), 0);
    const meanVol252 = sumVol252 / 252;

    const sumVol20 = windowBars20.reduce((acc, b) => acc + (b.volume || 0), 0);
    const meanVol20 = sumVol20 / 20;

    if (meanVol252 === 0) {
      return {
        formulaId,
        formulaText,
        window: windowLabel,
        value: null,
        formatted: "-",
        barsUsed: 252,
        firstDateUsed: windowBars252[0].bar_date,
        lastDateUsed: windowBars252[251].bar_date,
        state: "NOT_MEANINGFUL",
        warnings: [...warnings, "252-day average volume is zero."],
      };
    }

    const ratio = meanVol20 / meanVol252;
    return {
      formulaId,
      formulaText,
      window: windowLabel,
      value: ratio,
      formatted: `${formatNumber(ratio, 2)}x`,
      barsUsed: 252,
      firstDateUsed: windowBars252[0].bar_date,
      lastDateUsed: windowBars252[251].bar_date,
      state: "OK",
      warnings,
    };
  };

  const relativeActivity = computeRelativeActivity();

  // Large Daily Moves (days with |c_t / c_{t-1} - 1| > 20% in last 252 daily returns, needs 253 bars)
  const computeLargeDailyMoves = (): {
    metric: TrendMetricValue;
    moves: LargeDailyMove[];
  } => {
    const formulaId = "large_moves_count";
    const formulaText = "count of days with |c_t / c_{t-1} - 1| > 20% in last 252 daily returns";
    const windowLabel = "252 trading days";

    if (totalBars < 253) {
      return {
        metric: {
          formulaId,
          formulaText,
          window: windowLabel,
          value: null,
          formatted: "-",
          barsUsed: totalBars,
          firstDateUsed: validBars[0]?.bar_date ?? null,
          lastDateUsed: asOfDate,
          state: "INSUFFICIENT_HISTORY",
          warnings: [`Requires at least 253 trading days (252 returns); ${totalBars} available.`],
        },
        moves: [],
      };
    }

    const windowBars = validBars.slice(totalBars - 253);
    const warnings = checkWindowGaps(windowBars);
    const largeMoves: LargeDailyMove[] = [];

    for (let i = 1; i < windowBars.length; i++) {
      const prevClose = windowBars[i - 1].close;
      const currClose = windowBars[i].close;
      const change = currClose / prevClose - 1;
      if (Math.abs(change) > 0.2) {
        largeMoves.push({
          date: windowBars[i].bar_date,
          previousClose: prevClose,
          close: currClose,
          percentChange: Math.round(change * 10_000) / 100,
        });
      }
    }

    return {
      metric: {
        formulaId,
        formulaText,
        window: windowLabel,
        value: largeMoves.length,
        formatted: String(largeMoves.length),
        barsUsed: 253,
        firstDateUsed: windowBars[0].bar_date,
        lastDateUsed: windowBars[252].bar_date,
        state: "OK",
        warnings,
      },
      moves: largeMoves,
    };
  };

  const { metric: largeDailyMovesCount, moves: largeDailyMoves } = computeLargeDailyMoves();

  // Identify all large daily moves across all valid bars for window warnings
  const allLargeMoves: LargeDailyMove[] = [];
  for (let i = 1; i < validBars.length; i++) {
    const prevClose = validBars[i - 1].close;
    const currClose = validBars[i].close;
    const change = currClose / prevClose - 1;
    if (Math.abs(change) > 0.2) {
      allLargeMoves.push({
        date: validBars[i].bar_date,
        previousClose: prevClose,
        close: currClose,
        percentChange: Math.round(change * 10_000) / 100,
      });
    }
  }

  const metricsRecord = {
    latestClose,
    return1M,
    return3M,
    return6M,
    returnYTD,
    return1Y,
    sma50,
    sma200,
    distanceFromSma50,
    distanceFromSma200,
    sma50VsSma200,
    high52W,
    low52W,
    position52W,
    distanceFrom52WHigh,
    volatility20D,
    volatility1Y,
    maxDrawdown1Y,
    relativeActivity,
    largeDailyMovesCount,
  };

  // Rule: if a metric's calculation window covers a >20% single-day move,
  // attach warning: "Contains a one-day move of X% on YYYY-MM-DD, which may be an unadjusted corporate action."
  for (const [key, metric] of Object.entries(metricsRecord)) {
    if (key === "largeDailyMovesCount") continue;
    if (
      metric.firstDateUsed &&
      metric.lastDateUsed &&
      metric.state !== "SUSPENDED" &&
      metric.state !== "INSUFFICIENT_HISTORY"
    ) {
      for (const move of allLargeMoves) {
        if (move.date >= metric.firstDateUsed && move.date <= metric.lastDateUsed) {
          const pctStr = `${move.percentChange > 0 ? "+" : ""}${move.percentChange}%`;
          const msg = `Contains a one-day move of ${pctStr} on ${move.date}, which may be an unadjusted corporate action.`;
          if (!metric.warnings.includes(msg)) {
            metric.warnings.push(msg);
          }
        }
      }
    }
  }

  // Summary for table view
  let summaryState: TrendMetricState = "OK";
  if (
    return1M.state === "INSUFFICIENT_HISTORY" &&
    return1Y.state === "INSUFFICIENT_HISTORY" &&
    position52W.state === "INSUFFICIENT_HISTORY"
  ) {
    summaryState = "INSUFFICIENT_HISTORY";
  }

  const trendSummary: TrendSummary = {
    return1M: return1M.state === "OK" ? return1M.value : null,
    return1Y: return1Y.state === "OK" ? return1Y.value : null,
    position52W: position52W.state === "OK" ? position52W.value : null,
    state: summaryState,
    asOfDate,
    isStale,
  };

  return {
    asOfDate,
    isStale,
    staleDays,
    rebackfillNeeded: false,
    seriesVersion,
    metrics: metricsRecord,
    largeDailyMoves,
    trendSummary,
    disclaimer: EQUITY_TREND_DISCLAIMER,
    warnings: globalWarnings,
  };
}
