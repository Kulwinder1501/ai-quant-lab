/**
 * The stop-loss and target a hand-taken option buy must carry.
 *
 * Both are premium levels, the same convention the automated option entries use: the exit sweep closes the
 * position when the contract's mark reaches either one. They are required because without them the position
 * would sit with no exit at all -- a manual position has no candle timeframe, so the 15:15 square-off does not
 * touch it either.
 */
export type ManualOptionBarriers =
  | { ok: true; stopLoss: number; targetPrice: number }
  | { ok: false; error: string };

function positiveNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** Shape check, before any quote is read: both must be present and positive. */
export function parseManualOptionBarriers(stopLoss: unknown, targetPrice: unknown): ManualOptionBarriers {
  const stop = positiveNumber(stopLoss);
  const target = positiveNumber(targetPrice);
  if (stop === null || target === null) {
    return { ok: false, error: "stopLoss and targetPrice (option premiums, positive numbers) are required for a manual option trade." };
  }
  return { ok: true, stopLoss: stop, targetPrice: target };
}

/**
 * Geometry against the price the buyer actually pays. A buyer is long the premium, so the stop must sit
 * below the fill and the target above it. Checked against the server's observed ask, not the price the
 * screen showed, because the ask can move between the click and the booking.
 */
export function checkManualOptionGeometry(
  barriers: { stopLoss: number; targetPrice: number },
  fillPrice: number,
  /** What `fillPrice` is, for the message: the current ask for a market buy, the limit for a limit order. */
  priceLabel = "the current ask",
): string | null {
  const hint = priceLabel === "the current ask" ? " The ask may have moved since the ticket opened." : "";
  if (barriers.stopLoss >= fillPrice) {
    return `The stop loss (${barriers.stopLoss}) must be below the fill price (${fillPrice}, ${priceLabel}).${hint}`;
  }
  if (barriers.targetPrice <= fillPrice) {
    return `The target (${barriers.targetPrice}) must be above the fill price (${fillPrice}, ${priceLabel}).${hint}`;
  }
  return null;
}
