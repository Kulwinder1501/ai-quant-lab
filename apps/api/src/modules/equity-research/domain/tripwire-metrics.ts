/**
 * Live Tripwire Metrics for Equity Alerts (Gate Step 6)
 *
 * Pre-registered Criteria:
 * - Budget: Median <= 3.0 alerts per stock-month, p95 <= 8.0 alerts per stock-month.
 * - Live Tripwire Condition: p95 > 8.0 alerts per stock-month over the first 20 trading days
 *   means tighten once more before proceeding.
 */

export interface StockAlertCount {
  stockId: string;
  symbol: string;
  levelAlertsCount: number;
  totalAlertsCount: number;
}

export interface TripwireDistribution {
  sampleSize: number;
  tradingDays: number;
  scalingFactor: number;
  median: number;
  mean: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  tripwireTriggered: boolean;
  status: "TRIPWIRE_CLEAR" | "TRIPWIRE_TRIGGERED";
  message: string;
}

/**
 * Computes frequency distribution and evaluates the live tripwire gate across active stocks.
 *
 * @param stockCounts Array of active stocks with their alert counts in the evaluated trading window.
 * @param tradingDays Number of distinct trading days in the evaluated window (standard month = 20 days).
 */
export function computeTripwireMetrics(
  stockCounts: StockAlertCount[],
  tradingDays: number = 20,
): TripwireDistribution {
  const scalingFactor = tradingDays > 0 ? 20 / tradingDays : 1.0;
  const scaledMonthlyCounts = stockCounts.map((s) => s.levelAlertsCount * scalingFactor);

  scaledMonthlyCounts.sort((a, b) => a - b);
  const n = scaledMonthlyCounts.length;

  if (n === 0) {
    return {
      sampleSize: 0,
      tradingDays,
      scalingFactor,
      median: 0,
      mean: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      max: 0,
      tripwireTriggered: false,
      status: "TRIPWIRE_CLEAR",
      message: "No active stocks evaluated; tripwire clear.",
    };
  }

  const median =
    n % 2 === 0
      ? (scaledMonthlyCounts[n / 2 - 1] + scaledMonthlyCounts[n / 2]) / 2
      : scaledMonthlyCounts[Math.floor(n / 2)];
  const p75 = scaledMonthlyCounts[Math.floor(n * 0.75)];
  const p90 = scaledMonthlyCounts[Math.floor(n * 0.90)];
  const p95 = scaledMonthlyCounts[Math.floor(n * 0.95)];
  const p99 = scaledMonthlyCounts[Math.floor(n * 0.99)];
  const mean = scaledMonthlyCounts.reduce((a, b) => a + b, 0) / n;
  const max = scaledMonthlyCounts[n - 1] ?? 0;

  // The live tripwire threshold: p95 > 8.0 alerts per stock-month over 20 trading days
  const tripwireTriggered = p95 > 8.0;
  const status: "TRIPWIRE_CLEAR" | "TRIPWIRE_TRIGGERED" = tripwireTriggered
    ? "TRIPWIRE_TRIGGERED"
    : "TRIPWIRE_CLEAR";
  const message = tripwireTriggered
    ? `Live tripwire TRIGGERED: 95th percentile (${p95.toFixed(1)}) exceeds budget limit of 8.0 alerts/month over ${tradingDays} trading days. Tighten calibration before proceeding.`
    : `Live tripwire CLEAR: 95th percentile (${p95.toFixed(1)} <= 8.0) and median (${median.toFixed(1)} <= 3.0) satisfy frequency budget over ${tradingDays} trading days.`;

  return {
    sampleSize: n,
    tradingDays,
    scalingFactor: Number(scalingFactor.toFixed(4)),
    median: Number(median.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    p75: Number(p75.toFixed(2)),
    p90: Number(p90.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
    max: Number(max.toFixed(2)),
    tripwireTriggered,
    status,
    message,
  };
}
