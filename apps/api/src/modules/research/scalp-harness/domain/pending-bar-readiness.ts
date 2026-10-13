/**
 * When a pending 1m bar is ready to be captured by the scalp research harness.
 *
 * Two layers have to exist for a bar before a decision on it can be trusted: the pattern layer (candlestick and
 * price action) and the canonical ATR(14), which fixes the geometry of every proposal. The harness used to wait
 * only for the first. A bar whose ATR was never computed therefore sailed through the gate, produced a proposal,
 * and the capture step threw "requires completed ta-v1 Wilder ATR(14)" -- which killed the whole run. The bar
 * stayed pending and, being the oldest, was the first one every later run picked up, so one missing indicator row
 * stopped capture for every instrument for the rest of the day.
 *
 * A bar that is not ready is deferred while it is young, so a late indicator can still arrive. Past the wait
 * window it is captured anyway, as a control point with no proposals (featureCoverage INCOMPLETE): the grid point
 * is not lost, and no row is minted from a layer that was not there. Skipping is recoverable; a wrong row, or a
 * stalled harness, is not.
 */
export type BarReadiness = "DEFER" | "CAPTURE";

export function decideBarReadiness(input: {
  featuresCovered: boolean;
  atrComputed: boolean;
  /** How long ago the bar closed. */
  ageMs: number;
  /** How long the harness waits for the layers before capturing without them. */
  waitMs: number;
}): BarReadiness {
  const ready = input.featuresCovered && input.atrComputed;
  return !ready && input.ageMs < input.waitMs ? "DEFER" : "CAPTURE";
}
