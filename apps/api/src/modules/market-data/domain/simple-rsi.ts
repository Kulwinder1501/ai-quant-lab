export const RSI_PERIOD = 14;

/**
 * Simple-average RSI over the trailing period, or null before enough closes exist.
 *
 * Exists because both seeds previously wrote
 * `Math.floor(40 + Math.random() * 30)` into `indicator_snapshots` as though it were
 * a measured indicator. It is computed from the same real closes the seeds already
 * use for their SMA, Bollinger, EMA, and VWAP values.
 *
 * Deliberately *not* the production `rsi()` in `technical-indicator-engine.ts`, which
 * applies Wilder smoothing over a whole series. Seed rows are registered under
 * algorithm version `v1` precisely so they can never be mistaken for the `ta-v1`
 * contract the strategies resolve against, and reusing the production algorithm under
 * a different version string would blur exactly the line that separation draws. This
 * is the plain textbook average, named and versioned as such.
 */
export function simpleRsi(closes: readonly number[]): number | null {
  if (closes.length < RSI_PERIOD + 1) return null;
  const window = closes.slice(-(RSI_PERIOD + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < window.length; index += 1) {
    const change = window[index] - window[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const averageGain = gains / RSI_PERIOD;
  const averageLoss = losses / RSI_PERIOD;
  // An unbroken run of gains has no downside to divide by; RSI is 100 by definition.
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}
