/**
 * Helpers for charts whose X axis is categorical strikes.
 *
 * A categorical axis only accepts values that exist in the series, so a marker for spot (which is
 * almost never exactly a strike) must be snapped to the nearest strike. The marker's *label* should
 * still carry the true value; only its position is approximate, by at most half a strike step.
 */

/** Inclusive half-width, in strikes, of the window every strike chart centres on ATM. */
export const DEFAULT_STRIKE_WINDOW = 12;

/**
 * The strike in `strikes` closest to `target`, or null when there is nothing to snap to.
 * Ties resolve to the lower strike (first in ascending input), which is deterministic.
 */
export function nearestStrikeOnAxis(strikes: readonly number[], target: number | null): number | null {
  if (target === null || !Number.isFinite(target) || strikes.length === 0) return null;
  let best = strikes[0]!;
  let bestDistance = Math.abs(best - target);
  for (const strike of strikes) {
    const distance = Math.abs(strike - target);
    if (distance < bestDistance) {
      best = strike;
      bestDistance = distance;
    }
  }
  return best;
}
