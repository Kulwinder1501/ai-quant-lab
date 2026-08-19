/**
 * Converts a bracket's gross R into a net R after a round-trip execution cost.
 *
 * ## Why the cost is expressed in basis points and nothing else
 *
 * The protocol writes `netPnl = grossPnl - brokerage - taxes - statutoryCharges - slippageCost`. This
 * implements the whole of that as a single round-trip figure in basis points of notional, and the
 * omission is deliberate rather than an approximation left half-done.
 *
 * Experiment A runs on NIFTYBEES and BANKBEES, which are proxies for the series the live bots actually
 * trade. An itemised Indian equity fee schedule -- brokerage caps, intraday STT on the sell side,
 * exchange transaction charges, GST, SEBI turnover fees, stamp duty -- would add four decimal places of
 * precision to a number whose *purpose* is relative comparison, and every one of those rates would be
 * a figure asserted here rather than verified. This codebase has been burned by exactly that kind of
 * confident invented constant. So the terms are folded into one bps figure, and the 1 / 2 / 5 bps
 * ladder is what carries the uncertainty.
 *
 * ## Why this still discriminates between the architectures
 *
 * A flat per-trade cost does not cancel across arms, and that is the point of the experiment. Cost in R
 * is `bps x entryPrice / riskPerUnit`, and `riskPerUnit` is an ATR multiple -- so a 1-minute bar's
 * tighter ATR makes the identical bps cost consume a larger share of a risk unit. Faster architectures
 * pay more, in exactly the proportion their own stop distance sets. Nothing about that mechanism needs
 * an invented fee table.
 */

export interface NetOutcomeInput {
  /** Realised multiple of the risked distance, before costs. */
  readonly grossR: number;
  /** The bracket's risked distance in price, entry to stop. Must be positive. */
  readonly riskPerUnit: number;
  /** Fill price the round trip is charged against. */
  readonly entryPrice: number;
  /** One-way execution cost in basis points of notional. Charged twice, entry and exit. */
  readonly costBps: number;
}

/**
 * Cost of a round trip expressed in risk units.
 *
 * Charged twice because a bracket both opens and closes. Returned separately from the net figure so a
 * report can state what was paid rather than only what was left.
 */
export function roundTripCostR(input: Omit<NetOutcomeInput, "grossR">): number {
  if (!Number.isFinite(input.riskPerUnit) || input.riskPerUnit <= 0) {
    throw new Error("Round-trip cost needs a positive risk per unit.");
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("Round-trip cost needs a positive entry price.");
  }
  if (!Number.isFinite(input.costBps) || input.costBps < 0) {
    throw new Error("Round-trip cost needs a non-negative basis-point figure.");
  }
  return (2 * (input.costBps / 10_000) * input.entryPrice) / input.riskPerUnit;
}

export function netOutcomeR(input: NetOutcomeInput): number {
  if (!Number.isFinite(input.grossR)) {
    throw new Error("Net outcome needs a finite gross R.");
  }
  return input.grossR - roundTripCostR(input);
}
