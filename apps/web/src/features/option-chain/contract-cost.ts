/**
 * What it costs to be long one option, and what the market has to do for it to pay. Pure, no React.
 *
 * Everything is per ONE unit of the underlying (multiply by the lot size for rupees per lot, as the Greeks tab says), and each
 * figure is one of three kinds, labelled on the screen:
 *
 * 1. **Observed prices:** the bid, the ask and the spread between them. A buyer pays the ask and, selling at once, receives the
 *    bid, so the spread is what getting in and out immediately costs. A one-sided quote (no bid, or no ask) has an unknown spread
 *    and no price to pay, so nothing is derived from it: unknown is not cheap.
 * 2. **Arithmetic on those prices:** the breakeven at expiry (strike plus the ask for a call, minus it for a put), how far the
 *    index has to move from here to reach it, and the split of the ask into intrinsic and time value.
 * 3. **Model readings:** theta (premium lost per calendar day at today's rate), delta, gamma and IV, from Black-Scholes at the
 *    leg's solved IV; and the typical-move band from `implied-move.ts`, against which the needed move is put.
 *
 * ## What it does not say
 * It is not a probability of profit and not a recommendation. The breakeven is a statement about expiry; before expiry the option
 * can be sold for more than intrinsic value, and theta is today's rate, which rises as expiry nears. Putting the needed move beside
 * a typical move says how large the hurdle is, not whether it will be cleared.
 */
import type { ImpliedMove } from "./implied-move";

export type OptionSide = "CE" | "PE";

export interface CostLeg {
  bid: number | null;
  ask: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  /** Premium per calendar day, per unit; negative for a long option. */
  theta: number | null;
  daysToExpiry: number | null;
}

export interface ContractCostInput {
  optionType: OptionSide;
  strike: number;
  spot: number | null;
  leg: CostLeg | null;
}

export interface NeededMove {
  /** Signed, in the direction the position needs: positive means the index must still move that far. Negative: already past it. */
  points: number;
  percentOfSpot: number;
  direction: "up" | "down";
  /** True when the breakeven at expiry is already behind the index. */
  alreadyPastBreakeven: boolean;
}

export interface ContractCost {
  /** Null unless the quote is two-sided (a positive bid and an ask not below it). */
  quote: { bid: number; ask: number; mid: number; spreadPoints: number; spreadPercentOfMid: number } | null;
  /** What it costs to buy at the ask and sell at the bid straight away, as a share of the ask. */
  roundTripPercentOfAsk: number | null;
  breakevenAtExpiry: number | null;
  neededMove: NeededMove | null;
  /** The needed move over the expected absolute daily move (a range over the day-count convention) and over one sigma to expiry. */
  neededOverDaily: { low: number; high: number } | null;
  neededOverToExpiry: number | null;
  intrinsic: number | null;
  /** Ask minus intrinsic. Negative means the ask is below intrinsic value (a stale or crossed price): shown, not hidden. */
  timeValue: number | null;
  timeValueShareOfAsk: number | null;
  belowIntrinsic: boolean;
  /** Today's theta as a positive loss per calendar day, and as a share of the ask. Null without a theta. */
  thetaLossPerDay: number | null;
  thetaLossPercentOfAsk: number | null;
  delta: number | null;
  gamma: number | null;
  impliedVolatility: number | null;
  daysToExpiry: number | null;
}

function twoSided(leg: CostLeg | null): ContractCost["quote"] {
  if (!leg || leg.bid === null || leg.ask === null) return null;
  if (!Number.isFinite(leg.bid) || !Number.isFinite(leg.ask) || !(leg.bid > 0) || leg.ask < leg.bid) return null;
  const mid = (leg.bid + leg.ask) / 2;
  const spreadPoints = leg.ask - leg.bid;
  return { bid: leg.bid, ask: leg.ask, mid, spreadPoints, spreadPercentOfMid: (spreadPoints / mid) * 100 };
}

export function buildContractCost(input: ContractCostInput, implied: ImpliedMove | null): ContractCost {
  const { optionType, strike, spot, leg } = input;
  const quote = twoSided(leg);
  const haveSpot = spot !== null && spot > 0;

  const breakevenAtExpiry = quote ? (optionType === "CE" ? strike + quote.ask : strike - quote.ask) : null;
  const neededMove: NeededMove | null = breakevenAtExpiry !== null && haveSpot
    ? (() => {
      const points = optionType === "CE" ? breakevenAtExpiry - spot! : spot! - breakevenAtExpiry;
      return { points, percentOfSpot: (points / spot!) * 100, direction: optionType === "CE" ? "up" as const : "down" as const, alreadyPastBreakeven: points < 0 };
    })()
    : null;

  const intrinsic = haveSpot ? Math.max(0, optionType === "CE" ? spot! - strike : strike - spot!) : null;
  const timeValue = quote && intrinsic !== null ? quote.ask - intrinsic : null;

  // The hurdle is only compared with a typical move when there is still a hurdle: a breakeven already behind the index is not a ratio.
  const hurdle = neededMove !== null && neededMove.points > 0 ? neededMove.points : null;
  const daily = implied?.expectedAbsDailyPoints ?? null;
  const toExpiry = implied?.oneSigmaToExpiryPoints ?? null;
  const theta = leg?.theta ?? null;

  return {
    quote,
    roundTripPercentOfAsk: quote ? (quote.spreadPoints / quote.ask) * 100 : null,
    breakevenAtExpiry,
    neededMove,
    neededOverDaily: hurdle !== null && daily !== null ? { low: hurdle / daily.high, high: hurdle / daily.low } : null,
    neededOverToExpiry: hurdle !== null && toExpiry !== null && toExpiry > 0 ? hurdle / toExpiry : null,
    intrinsic,
    timeValue,
    timeValueShareOfAsk: quote && timeValue !== null ? timeValue / quote.ask : null,
    belowIntrinsic: timeValue !== null && timeValue < 0,
    thetaLossPerDay: theta !== null ? -theta : null,
    thetaLossPercentOfAsk: quote && theta !== null ? (-theta / quote.ask) * 100 : null,
    delta: leg?.delta ?? null,
    gamma: leg?.gamma ?? null,
    impliedVolatility: leg?.impliedVolatility ?? null,
    daysToExpiry: leg?.daysToExpiry ?? null,
  };
}

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function two(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function band(range: { low: number; high: number }): string {
  const low = range.low.toFixed(2);
  const high = range.high.toFixed(2);
  return low === high ? `${low}×` : `${low}×–${high}×`;
}

/** The hurdle in one sentence: where it breaks even at expiry, how far the index has to go, and how that compares with a typical move. */
export function hurdleSentence(cost: ContractCost, side: OptionSide, strike: number): string | null {
  if (cost.quote === null || cost.breakevenAtExpiry === null || cost.neededMove === null) return null;
  const head = `Bought at the ask of ${two(cost.quote.ask)}, the ${points(strike)} ${side === "CE" ? "call" : "put"} breaks even at expiry at ${points(cost.breakevenAtExpiry)}`;
  if (cost.neededMove.alreadyPastBreakeven) {
    // For a long option the breakeven is behind the index exactly when the ask is below intrinsic value, so this is a bad quote, not a bargain.
    return `${head}, which the index is already past by ${points(-cost.neededMove.points)} points (${two(-cost.neededMove.percentOfSpot)}%). That can only happen when the ask is below intrinsic value, so the quote is stale or crossed and the hurdle is not meaningful.`;
  }
  const move = `${points(cost.neededMove.points)} points (${two(cost.neededMove.percentOfSpot)}%) ${cost.neededMove.direction} from here`;
  const against = [
    cost.neededOverDaily ? `${band(cost.neededOverDaily)} a typical day's absolute move` : null,
    cost.neededOverToExpiry !== null ? `${cost.neededOverToExpiry.toFixed(2)}× one standard deviation to expiry` : null,
  ].filter((part): part is string => part !== null);
  return `${head}: ${move}${against.length > 0 ? `, ${against.join(" and ")}` : ""}.`;
}

export interface CostNote {
  tone: "info" | "warn";
  text: string;
}

/** What is missing or odd about this contract, in words. */
export function contractCostNotes(cost: ContractCost, leg: CostLeg | null): CostNote[] {
  const notes: CostNote[] = [];
  if (leg === null) {
    notes.push({ tone: "warn", text: "This contract is not in the stored chain." });
    return notes;
  }
  if (cost.quote === null) {
    notes.push({ tone: "warn", text: "No two-sided quote (a bid and an ask): there is no price to pay and no spread, so no breakeven, hurdle or time value is derived. An unquoted contract is unknown, not cheap." });
  }
  if (cost.belowIntrinsic) {
    notes.push({ tone: "warn", text: "The ask is below the option's intrinsic value, which a live market does not allow: the quote is stale or crossed, and the time value shown is negative." });
  }
  if (cost.thetaLossPerDay === null && cost.quote !== null) {
    notes.push({ tone: "info", text: "No theta: the implied volatility could not be solved for this contract, so no Greek is shown (none is invented at a house volatility)." });
  }
  return notes;
}

export const CONTRACT_COST_DEFINITIONS = {
  perUnit: "Every figure is per one unit of the underlying. Multiply by the lot size for rupees per lot.",
  spread: "Observed: the ask minus the bid. A buyer pays the ask; selling straight away receives the bid, so the spread is what getting in and out at once costs. Needs a positive bid and an ask.",
  breakeven: "The strike plus the ask for a call, minus it for a put: where the option is worth what was paid, at expiry. Before expiry it can be sold for more than intrinsic value, so this is the hurdle at expiry, not the price at which a sale breaks even.",
  needed: "How far the index has to move from here to reach that breakeven, in points and as a percent of the index, set beside the typical-move figures from the implied-move panel (a range for the day, because of the day-count convention).",
  timeValue: "The ask minus intrinsic value (how far the option is in the money). What is left is the price of time and volatility; it is what decays.",
  theta: "Model: the premium lost per calendar day at today's rate, from Black-Scholes at the leg's solved IV. It rises as expiry nears.",
  notAdvice: "Not a probability of profit and not a recommendation: how large the hurdle is says nothing about whether it will be cleared.",
} as const;
