/**
 * What one long option pays at expiry across a range of index levels. Pure, no React.
 *
 * Everything here is arithmetic on one observed price, the ask the buyer pays: at expiry a call is worth `max(0, level - strike)`
 * and a put `max(0, strike - level)`, so the result per unit is that minus the ask. There is no model in it: no volatility, no
 * probability, no theta. It is the shape of the position if it is held to expiry, and nothing else.
 *
 * ## What it does not say
 * - **Before expiry.** A sale earlier receives the bid, and the option is worth more than intrinsic value until the end, so the line
 *   is the outcome at expiry, not the result of selling on the way.
 * - **How likely any level is.** The levels are spaced as a percent of the index (and each is labelled with its distance in typical
 *   one-sigma moves to expiry when that is known) so the reader can see how far each one is, not how probable.
 * - **Costs beyond the spread.** Brokerage, taxes and slippage are not included; the entry price is the ask as quoted.
 */

export type PayoffSide = "CE" | "PE";

export interface PayoffInput {
  optionType: PayoffSide;
  strike: number;
  /** The ask paid to get in; null when there is no two-sided quote, in which case there is no payoff. */
  ask: number | null;
  spot: number | null;
  /** One standard deviation of the move to expiry, in points (from the implied-move panel); null when unknown. */
  oneSigmaToExpiryPoints: number | null;
}

export type PayoffLabel = "spot" | "strike" | "breakeven";

export interface PayoffRow {
  level: number;
  labels: PayoffLabel[];
  /** The option's value at expiry at this level, per unit. */
  intrinsicAtExpiry: number;
  /** Intrinsic value at expiry minus the ask. */
  pnl: number;
  pnlPercentOfAsk: number;
  moveFromSpotPoints: number;
  moveFromSpotPercent: number;
  /** The move from spot in one-sigma-to-expiry units; null when no sigma is known. */
  sigmas: number | null;
}

export interface Payoff {
  ask: number;
  breakeven: number;
  rows: PayoffRow[];
  /** Per unit, at expiry: the premium, whatever the index does. */
  maxLoss: number;
  /** Per unit: a put's gain is capped at the strike minus the ask (the index cannot go below zero); a call's is unbounded (null). */
  maxGain: number | null;
}

/** Index levels, as a percent move from the spot, that the payoff is tabulated at. */
export const PAYOFF_PERCENT_STEPS = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3] as const;

const TOLERANCE = 1e-6;

export function valueAtExpiry(side: PayoffSide, strike: number, level: number): number {
  return Math.max(0, side === "CE" ? level - strike : strike - level);
}

export function buildPayoff(input: PayoffInput): Payoff | null {
  const { optionType, strike, ask, spot, oneSigmaToExpiryPoints } = input;
  if (ask === null || !(ask > 0) || spot === null || !(spot > 0)) return null;
  const breakeven = optionType === "CE" ? strike + ask : strike - ask;

  const wanted: Array<{ level: number; label: PayoffLabel | null }> = [
    ...PAYOFF_PERCENT_STEPS.map((percent) => ({ level: spot + (spot * percent) / 100, label: percent === 0 ? "spot" as const : null })),
    { level: strike, label: "strike" as const },
    { level: breakeven, label: "breakeven" as const },
  ].filter((entry) => entry.level >= 0);

  // Merge levels that coincide, keeping every label they carry.
  const merged: Array<{ level: number; labels: PayoffLabel[] }> = [];
  for (const entry of wanted.sort((a, b) => a.level - b.level)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.level - entry.level) < TOLERANCE) {
      if (entry.label) last.labels.push(entry.label);
    } else {
      merged.push({ level: entry.level, labels: entry.label ? [entry.label] : [] });
    }
  }

  const sigma = oneSigmaToExpiryPoints !== null && oneSigmaToExpiryPoints > 0 ? oneSigmaToExpiryPoints : null;
  const rows = merged.map(({ level, labels }): PayoffRow => {
    const intrinsicAtExpiry = valueAtExpiry(optionType, strike, level);
    const pnl = intrinsicAtExpiry - ask;
    return {
      level,
      labels,
      intrinsicAtExpiry,
      pnl,
      pnlPercentOfAsk: (pnl / ask) * 100,
      moveFromSpotPoints: level - spot,
      moveFromSpotPercent: ((level - spot) / spot) * 100,
      sigmas: sigma !== null ? (level - spot) / sigma : null,
    };
  });

  return { ask, breakeven, rows, maxLoss: ask, maxGain: optionType === "CE" ? null : strike - ask };
}

export const CONTRACT_PAYOFF_DEFINITIONS = {
  atExpiry: "Per unit, if held to expiry: what the option is worth at that index level (zero out of the money, the distance past the strike in the money) minus the ask paid. Arithmetic on one observed price; no model is used.",
  levels: "The index levels are spaced as a percent of today's index, with the strike and the breakeven added. Each row also says how many typical (one standard deviation) moves to expiry it is from here, so its distance can be judged; that is not how likely it is.",
  notBeforeExpiry: "Not what a sale before expiry would get: that receives the bid and the option is still worth more than intrinsic value. Brokerage, taxes and slippage are not included.",
  maxima: "The most that can be lost is the whole premium. A call's gain has no upper limit; a put's is capped at the strike minus the ask, because the index cannot fall below zero.",
} as const;
