import { describe, expect, it } from "vitest";
import {
  calendarDaysDifference,
  calendarDaysPrior,
  computeTrendPanel,
  EQUITY_TREND_DISCLAIMER,
  formatDateParts,
  getDaysInMonth,
  parseDateParts,
  subtractCalendarDays,
  subtractCalendarMonths,
  type TrendMetricsInput,
} from "./trend-metrics.js";

// Helper to generate N consecutive daily bars (skipping weekends or keeping linear dates)
function generateDailyBars(
  count: number,
  startDateStr: string,
  baseClose = 100,
  dailyIncrement = 0.5,
  volume = 1_000,
) {
  const bars: TrendMetricsInput["bars"] = [];
  const [y, m, d] = startDateStr.split("-").map(Number);
  const current = new Date(Date.UTC(y, m - 1, d));

  let close = baseClose;
  for (let i = 0; i < count; i++) {
    const dateStr = current.toISOString().slice(0, 10);
    bars.push({
      bar_date: dateStr,
      open: close - 0.2,
      high: close + 1.0,
      low: close - 1.0,
      close: Math.round(close * 100) / 100,
      volume,
    });
    close += dailyIncrement;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return bars;
}

describe("Trend Metrics Domain Logic (Slice 1)", () => {
  describe("Date and Calendar Math", () => {
    it("parses and formats date parts correctly", () => {
      const parts = parseDateParts("2026-10-17");
      expect(parts).toEqual({ year: 2026, month: 10, day: 17 });
      expect(formatDateParts(2026, 10, 17)).toBe("2026-10-17");
      expect(formatDateParts(2026, 5, 4)).toBe("2026-05-04");
    });

    it("handles month-end arithmetic correctly (31 May minus 3 months -> 28 Feb)", () => {
      // 2026 is not a leap year -> Feb has 28 days
      expect(subtractCalendarMonths("2026-05-31", 3)).toBe("2026-02-28");
      // 2024 is a leap year -> Feb has 29 days
      expect(subtractCalendarMonths("2024-05-31", 3)).toBe("2024-02-29");
      // 31 Aug minus 1 month -> 31 July
      expect(subtractCalendarMonths("2026-08-31", 1)).toBe("2026-07-31");
      // 31 March minus 1 month -> 28 Feb (in 2026)
      expect(subtractCalendarMonths("2026-03-31", 1)).toBe("2026-02-28");
    });

    it("handles leap year boundaries (29 Feb 2024 minus 12 months -> 28 Feb 2023)", () => {
      expect(subtractCalendarMonths("2024-02-29", 12)).toBe("2023-02-28");
    });

    it("calculates calendar day differences accurately", () => {
      expect(calendarDaysDifference("2026-10-16", "2026-10-17")).toBe(1);
      expect(calendarDaysDifference("2026-10-17", "2026-10-16")).toBe(1);
      expect(calendarDaysDifference("2026-10-01", "2026-10-16")).toBe(15);
      expect(calendarDaysPrior("2026-10-16", "2026-10-10")).toBe(6);
    });

    it("subtracts calendar days correctly", () => {
      expect(subtractCalendarDays("2026-10-17", 1)).toBe("2026-10-16");
      expect(subtractCalendarDays("2026-03-01", 1)).toBe("2026-02-28");
      expect(subtractCalendarDays("2024-03-01", 1)).toBe("2024-02-29");
    });
  });

  describe("T2: Windows and Boundaries", () => {
    it("flips SMA200 from INSUFFICIENT_HISTORY to OK at exactly 200 bars", () => {
      // Exactly 199 bars
      const bars199 = generateDailyBars(199, "2026-01-01", 100, 0.5);
      const res199 = computeTrendPanel({ bars: bars199, rebackfillNeeded: false });
      expect(res199.metrics.sma200.state).toBe("INSUFFICIENT_HISTORY");
      expect(res199.metrics.sma200.barsUsed).toBe(199);
      expect(res199.metrics.sma200.value).toBeNull();
      expect(res199.metrics.distanceFromSma200.state).toBe("INSUFFICIENT_HISTORY");

      // Exactly 200 bars
      const bars200 = generateDailyBars(200, "2026-01-01", 100, 0.5);
      const res200 = computeTrendPanel({ bars: bars200, rebackfillNeeded: false });
      expect(res200.metrics.sma200.state).toBe("OK");
      expect(res200.metrics.sma200.barsUsed).toBe(200);
      expect(res200.metrics.sma200.value).toBeGreaterThan(0);
      expect(res200.metrics.distanceFromSma200.state).toBe("OK");
    });

    it("flips SMA50 from INSUFFICIENT_HISTORY to OK at exactly 50 bars", () => {
      const bars49 = generateDailyBars(49, "2026-01-01", 100, 0.5);
      const res49 = computeTrendPanel({ bars: bars49, rebackfillNeeded: false });
      expect(res49.metrics.sma50.state).toBe("INSUFFICIENT_HISTORY");
      expect(res49.metrics.sma50.barsUsed).toBe(49);

      const bars50 = generateDailyBars(50, "2026-01-01", 100, 0.5);
      const res50 = computeTrendPanel({ bars: bars50, rebackfillNeeded: false });
      expect(res50.metrics.sma50.state).toBe("OK");
      expect(res50.metrics.sma50.barsUsed).toBe(50);
      expect(res50.metrics.sma50.value).toBe(100 + 49 * 0.25);
    });

    it("handles reference date on a weekend/holiday by picking the nearest earlier bar within 5 days", () => {
      // Bar at 2026-09-12 (Saturday/Holiday), target 1M date from 2026-10-16 is 2026-09-16
      // If last bar before 2026-09-16 is 2026-09-12 (4 calendar days prior <= 5 days), it passes
      const bars = [
        { bar_date: "2026-09-12", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        { bar_date: "2026-10-16", open: 110, high: 112, low: 108, close: 110, volume: 1000 },
      ];
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.return1M.state).toBe("OK");
      expect(res.metrics.return1M.value).toBeCloseTo(0.1, 4); // (110 / 100) - 1 = +10%
      expect(res.metrics.return1M.formatted).toBe("+10.00%");
      expect(res.metrics.return1M.firstDateUsed).toBe("2026-09-12");
      expect(res.metrics.return1M.lastDateUsed).toBe("2026-10-16");
    });

    it("marks return as INSUFFICIENT_HISTORY when reference bar is older than 5 calendar days from target date", () => {
      // Target date for 1M back from 2026-10-16 is 2026-09-16
      // Reference bar at 2026-09-10 is 6 calendar days prior (> 5 days) -> failed 5-day rule
      const bars = [
        { bar_date: "2026-09-10", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        { bar_date: "2026-10-16", open: 110, high: 112, low: 108, close: 110, volume: 1000 },
      ];
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.return1M.state).toBe("INSUFFICIENT_HISTORY");
      expect(res.metrics.return1M.value).toBeNull();
      expect(res.metrics.return1M.warnings[0]).toContain("6 calendar days before reference date");
    });

    it("warns on data gaps greater than 10 calendar days within a metric's window", () => {
      const bars = [
        { bar_date: "2026-09-15", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        { bar_date: "2026-09-16", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        // 14 calendar days gap between 2026-09-16 and 2026-09-30
        { bar_date: "2026-09-30", open: 105, high: 107, low: 103, close: 105, volume: 1000 },
        { bar_date: "2026-10-16", open: 110, high: 112, low: 108, close: 110, volume: 1000 },
      ];
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.return1M.state).toBe("OK");
      expect(res.metrics.return1M.warnings.some((w) => w.includes("Contains a gap of 14 calendar days"))).toBe(true);
    });

    it("excludes non-positive or non-finite closes with warnings", () => {
      const bars = [
        { bar_date: "2026-09-16", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        { bar_date: "2026-09-20", open: 100, high: 102, low: 98, close: -5, volume: 1000 }, // Invalid!
        { bar_date: "2026-09-25", open: 100, high: 102, low: 98, close: NaN, volume: 1000 }, // Invalid!
        { bar_date: "2026-10-16", open: 110, high: 112, low: 108, close: 110, volume: 1000 },
      ];
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.warnings.length).toBe(2);
      expect(res.metrics.latestClose.value).toBe(110);
    });
  });

  describe("T3: Suspension (rebackfill_needed)", () => {
    it("suspends every metric when rebackfill_needed is true", () => {
      const bars = generateDailyBars(300, "2025-01-01", 100, 0.2);
      const res = computeTrendPanel({ bars, rebackfillNeeded: true, seriesVersion: 2 });

      expect(res.rebackfillNeeded).toBe(true);
      expect(res.seriesVersion).toBe(2);

      const metricKeys = Object.keys(res.metrics) as Array<keyof typeof res.metrics>;
      for (const key of metricKeys) {
        const metric = res.metrics[key];
        expect(metric.state).toBe("SUSPENDED");
        expect(metric.value).toBeNull();
        expect(metric.formatted).toBe("-");
        expect(metric.warnings[0]).toContain("Corporate action or restatement detected");
      }

      expect(res.trendSummary.state).toBe("SUSPENDED");
      expect(res.trendSummary.return1M).toBeNull();
      expect(res.trendSummary.return1Y).toBeNull();
      expect(res.trendSummary.position52W).toBeNull();
      expect(res.disclaimer).toBe(EQUITY_TREND_DISCLAIMER);
    });
  });

  describe("T4: Stale Status", () => {
    it("flags panel as stale when last bar is older than 4 calendar days", () => {
      const bars = [
        { bar_date: "2026-10-10", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
      ];
      // Evaluated as of 2026-10-16 (6 calendar days later)
      const res = computeTrendPanel({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: "2026-10-16",
      });

      expect(res.isStale).toBe(true);
      expect(res.staleDays).toBe(6);
      expect(res.warnings.some((w) => w.includes("as of 2026-10-10 (6 calendar days ago)"))).toBe(true);
      // Values are not hidden when stale
      expect(res.metrics.latestClose.value).toBe(100);
      expect(res.metrics.latestClose.state).toBe("OK");
    });

    it("is not stale when last bar is within 4 calendar days", () => {
      const bars = [
        { bar_date: "2026-10-14", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
      ];
      const res = computeTrendPanel({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: "2026-10-16",
      });

      expect(res.isStale).toBe(false);
      expect(res.staleDays).toBe(2);
    });
  });

  describe("T5: Banned Words Scanner", () => {
    it("verifies no banned terms exist in formulas, values, comparisons, or warnings across all scenarios", () => {
      // Banned words list from Slice 1 specification:
      // buy, sell, hold, bullish, bearish, strong, weak, overbought, oversold, signal, target, outperform, underperform, recommend
      // (except the literal phrase: "Not a recommendation, rating or forecast.")
      const bannedRegex =
        /\b(buy|sell|hold|bullish|bearish|strong|weak|overbought|oversold|signal|target|outperform|underperform|recommend)\b/i;

      function scanObject(obj: unknown, path = ""): void {
        if (typeof obj === "string") {
          // Allow the official disclaimer text: "Not a recommendation, rating or forecast."
          if (obj.includes("Not a recommendation, rating or forecast.")) return;

          const match = bannedRegex.exec(obj);
          if (match) {
            throw new Error(`Banned word '${match[1]}' found at path '${path}': "${obj}"`);
          }
        } else if (Array.isArray(obj)) {
          obj.forEach((item, idx) => scanObject(item, `${path}[${idx}]`));
        } else if (obj !== null && typeof obj === "object") {
          for (const [k, v] of Object.entries(obj)) {
            scanObject(v, `${path}.${k}`);
          }
        }
      }

      // Scenario A: Full history (400 bars)
      const resA = computeTrendPanel({ bars: generateDailyBars(400, "2025-01-01", 50, 0.1), rebackfillNeeded: false });
      expect(() => scanObject(resA, "scenarioA_full")).not.toThrow();

      // Scenario B: Insufficient history (under 1 year, e.g. 80 bars)
      const resB = computeTrendPanel({ bars: generateDailyBars(80, "2026-05-01", 100, 0.2), rebackfillNeeded: false });
      expect(() => scanObject(resB, "scenarioB_80bars")).not.toThrow();

      // Scenario C: Very short history (1 bar, 20 bars)
      const resC1 = computeTrendPanel({ bars: generateDailyBars(1, "2026-10-16", 100, 0), rebackfillNeeded: false });
      expect(() => scanObject(resC1, "scenarioC_1bar")).not.toThrow();
      const resC20 = computeTrendPanel({ bars: generateDailyBars(20, "2026-09-20", 100, 0.5), rebackfillNeeded: false });
      expect(() => scanObject(resC20, "scenarioC_20bars")).not.toThrow();

      // Scenario D: Completely empty bars
      const resD = computeTrendPanel({ bars: [], rebackfillNeeded: false });
      expect(() => scanObject(resD, "scenarioD_empty")).not.toThrow();

      // Scenario E: Suspended state
      const resE = computeTrendPanel({ bars: generateDailyBars(100, "2026-01-01", 50, 0.1), rebackfillNeeded: true });
      expect(() => scanObject(resE, "scenarioE_suspended")).not.toThrow();

      // Scenario F: Stale state with gaps & reference bar > 5 days
      const resF = computeTrendPanel({
        bars: [
          { bar_date: "2026-09-10", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
          { bar_date: "2026-10-10", open: 110, high: 112, low: 108, close: 110, volume: 1000 },
        ],
        rebackfillNeeded: false,
        asOfEvaluationDate: "2026-10-17",
      });
      expect(() => scanObject(resF, "scenarioF_stale_and_gap")).not.toThrow();
    });
  });

  describe("T6: Disclaimer & Adjusted Series Caveat", () => {
    it("always embeds the exact disclaimer string", () => {
      const bars = generateDailyBars(50, "2026-01-01", 100, 0.5);
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.disclaimer).toBe(
        "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.",
      );
    });
  });

  describe("52-Week Range & Drawdown", () => {
    it("computes 52-week high, low, position and distance correctly", () => {
      // 250 daily bars starting 2025-10-01 to ~2026-06-08 (within 365 days)
      const bars = generateDailyBars(250, "2025-10-01", 100, 1.0);
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });

      expect(res.metrics.high52W.state).toBe("OK");
      expect(res.metrics.low52W.state).toBe("OK");
      expect(res.metrics.position52W.state).toBe("OK");
      expect(res.metrics.distanceFrom52WHigh.state).toBe("OK");

      // Last bar close is near the high
      const posVal = res.metrics.position52W.value;
      expect(posVal).toBeGreaterThan(0.9);
      expect(res.metrics.position52W.formatted).toContain("%");
    });

    it("marks position as NOT_MEANINGFUL when 52-week high equals 52-week low (halted stock)", () => {
      // 220 bars with flat price 100.0
      const flatBars = generateDailyBars(220, "2025-10-01", 100, 0);
      flatBars.forEach((b) => {
        b.high = 100;
        b.low = 100;
        b.close = 100;
      });

      const res = computeTrendPanel({ bars: flatBars, rebackfillNeeded: false });
      expect(res.metrics.high52W.value).toBe(100);
      expect(res.metrics.low52W.value).toBe(100);
      expect(res.metrics.position52W.state).toBe("NOT_MEANINGFUL");
      expect(res.metrics.position52W.value).toBeNull();
      // Volatility on zero change is 0 with state OK
      expect(res.metrics.volatility20D.state).toBe("OK");
      expect(res.metrics.volatility20D.value).toBe(0);
      expect(res.metrics.volatility20D.formatted).toBe("0.0%");
    });

    it("computes 1-year maximum drawdown correctly", () => {
      // Create 210 bars with a peak at 200, then crash to 100 (-50% drawdown)
      const bars: TrendMetricsInput["bars"] = [];
      const current = new Date(Date.UTC(2025, 10, 1));
      for (let i = 0; i < 210; i++) {
        const dateStr = current.toISOString().slice(0, 10);
        let c = 100;
        if (i < 100) c = 100 + i; // rises to 199
        else if (i === 100) c = 200; // peak
        else c = 100; // drops to 100
        bars.push({ bar_date: dateStr, open: c, high: c, low: c, close: c, volume: 1000 });
        current.setUTCDate(current.getUTCDate() + 1);
      }

      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.maxDrawdown1Y.state).toBe("OK");
      expect(res.metrics.maxDrawdown1Y.value).toBe(-0.5);
      expect(res.metrics.maxDrawdown1Y.formatted).toBe("-50.00%");
    });
  });

  describe("Volatility (20-day and 1-year)", () => {
    it("requires 21 bars for 20-day volatility and 253 bars for 1-year volatility", () => {
      const bars20 = generateDailyBars(20, "2026-01-01", 100, 0.5);
      const res20 = computeTrendPanel({ bars: bars20, rebackfillNeeded: false });
      expect(res20.metrics.volatility20D.state).toBe("INSUFFICIENT_HISTORY");

      const bars21 = generateDailyBars(21, "2026-01-01", 100, 0.5);
      const res21 = computeTrendPanel({ bars: bars21, rebackfillNeeded: false });
      expect(res21.metrics.volatility20D.state).toBe("OK");
      expect(res21.metrics.volatility20D.value).toBeGreaterThan(0);
      expect(res21.metrics.volatility1Y.state).toBe("INSUFFICIENT_HISTORY");

      const bars253 = generateDailyBars(253, "2025-01-01", 100, 0.2);
      const res253 = computeTrendPanel({ bars: bars253, rebackfillNeeded: false });
      expect(res253.metrics.volatility1Y.state).toBe("OK");
      expect(res253.metrics.volatility1Y.value).toBeGreaterThan(0);
    });
  });

  describe("Relative Activity & Large Daily Moves", () => {
    it("computes relative activity and flags preliminary volume warning", () => {
      const bars = generateDailyBars(260, "2025-01-01", 100, 0.1, 1000);
      // Give last 20 bars double the volume (2,000)
      for (let i = 240; i < 260; i++) {
        bars[i].volume = 2000;
      }

      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.relativeActivity.state).toBe("OK");
      // 20-day mean = 2000. 252-day mean = (232 * 1000 + 20 * 2000) / 252 = 272000 / 252 ~= 1079.36
      // Ratio ~= 2000 / 1079.36 ~= 1.85x
      expect(res.metrics.relativeActivity.value).toBeCloseTo(1.85, 1);
      expect(res.metrics.relativeActivity.warnings).toContain("Latest day volume is preliminary.");
    });

    it("marks relative activity as NOT_MEANINGFUL if 252-day volume is zero", () => {
      const bars = generateDailyBars(260, "2025-01-01", 100, 0.1, 0); // 0 volume
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.relativeActivity.state).toBe("NOT_MEANINGFUL");
      expect(res.metrics.relativeActivity.value).toBeNull();
    });

    it("identifies large daily moves (> 20%) in the last 252 returns", () => {
      // 255 bars with steady price 100
      const bars = generateDailyBars(255, "2025-01-01", 100, 0);

      // Day 100 jumps from 100 to 125 (+25.00%)
      bars[100].close = 125;
      // Keep subsequent bars at 125 so only day 100 had the move
      for (let i = 101; i < 200; i++) {
        bars[i].close = 125;
      }

      // Day 200 drops from 125 to 95 (-24.00%)
      bars[200].close = 95;
      // Keep subsequent bars at 95
      for (let i = 201; i < 255; i++) {
        bars[i].close = 95;
      }

      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.largeDailyMovesCount.state).toBe("OK");
      expect(res.metrics.largeDailyMovesCount.value).toBe(2);
      expect(res.largeDailyMoves.length).toBe(2);
      expect(res.largeDailyMoves[0].percentChange).toBe(25);
      expect(res.largeDailyMoves[1].percentChange).toBe(-24);
    });

    it("attaches corporate action warning to metrics whose window covers a >20% move", () => {
      // 400 bars so 1Y return and 52-week metrics have full history (> 1 calendar year)
      const bars = generateDailyBars(400, "2024-01-01", 100, 0);

      // Day 100 jumps from 100 to 125 (+25.00%)
      bars[100].close = 125;
      for (let i = 101; i < 400; i++) {
        bars[i].close = 125;
      }

      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.return1Y.state).toBe("OK");
      expect(res.metrics.return1M.state).toBe("OK");

      const warning = `Contains a one-day move of +25% on ${bars[100].bar_date}, which may be an unadjusted corporate action.`;

      // 1Y return and 52-week metrics cover Day 100
      expect(res.metrics.return1Y.warnings).toContain(warning);
      expect(res.metrics.high52W.warnings).toContain(warning);

      // 1M return (last ~30 calendar days) and 20D volatility do NOT cover Day 100
      expect(res.metrics.return1M.warnings).not.toContain(warning);
      expect(res.metrics.volatility20D.warnings).not.toContain(warning);
    });

    it("evaluates staleness correctly against asOfEvaluationDate", () => {
      // 50 bars ending on 2026-09-01
      const bars = generateDailyBars(50, "2026-07-14", 100, 0.5);
      expect(bars[bars.length - 1].bar_date).toBe("2026-09-01");

      const res = computeTrendPanel({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: "2026-10-17",
      });

      expect(res.isStale).toBe(true);
      expect(res.staleDays).toBe(46);
      expect(res.warnings).toContain("Price data is as of 2026-09-01 (46 calendar days ago).");
    });
  });

  describe("50-day vs 200-day comparison statement", () => {
    it("produces strictly factual phrasing without crossover jargon", () => {
      const bars = generateDailyBars(220, "2025-01-01", 100, 0.5);
      const res = computeTrendPanel({ bars, rebackfillNeeded: false });
      expect(res.metrics.sma50VsSma200.state).toBe("OK");
      // SMA50 is higher because prices are monotonically rising
      expect(res.metrics.sma50VsSma200.formatted).toMatch(/50-day average is \d+\.\d+% above 200-day average/);
      // Verify no mention of cross / crossover
      expect(res.metrics.sma50VsSma200.formatted).not.toContain("cross");
      expect(res.metrics.sma50VsSma200.formatted).not.toContain("golden");
      expect(res.metrics.sma50VsSma200.formatted).not.toContain("death");
    });
  });
});
