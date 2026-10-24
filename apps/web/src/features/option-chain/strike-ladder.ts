/**
 * The contract cost of every strike side by side. Pure, no React.
 *
 * Each row is exactly what `buildContractCost` gives for that contract (so the ladder and the single-contract card cannot
 * disagree), set in strike order with its moneyness. Nothing is ranked, scored or marked "best": across strikes the spread, the
 * needed move and theta pull in different directions, and which trade-off suits a view is the reader's call. A contract with no
 * two-sided quote is kept as a row with nothing derived, because a gap in the ladder is information (unknown, not cheap).
 */
import { buildContractCost, type ContractCost, type CostLeg, type OptionSide } from "./contract-cost";
import type { ImpliedMove } from "./implied-move";

export interface LadderStrike {
  strikePrice: number;
  call: CostLeg | null;
  put: CostLeg | null;
}

export type Moneyness = "ITM" | "ATM" | "OTM";

export interface LadderRow {
  strike: number;
  moneyness: Moneyness;
  cost: ContractCost;
}

export interface LadderInput {
  side: OptionSide;
  strikes: LadderStrike[];
  spot: number | null;
  atmStrike: number | null;
}

/** In the money means a call struck below the index or a put struck above it; the ATM strike is labelled as such whichever side it is on. */
export function moneynessOf(side: OptionSide, strike: number, spot: number | null, atmStrike: number | null): Moneyness {
  if (strike === atmStrike) return "ATM";
  if (spot === null) return "OTM";
  return (side === "CE" ? strike < spot : strike > spot) ? "ITM" : "OTM";
}

export function buildStrikeLadder(input: LadderInput, implied: ImpliedMove | null): LadderRow[] {
  const { side, strikes, spot, atmStrike } = input;
  return [...strikes]
    .sort((a, b) => a.strikePrice - b.strikePrice)
    .map((entry) => ({
      strike: entry.strikePrice,
      moneyness: moneynessOf(side, entry.strikePrice, spot, atmStrike),
      cost: buildContractCost({ optionType: side, strike: entry.strikePrice, spot, leg: side === "CE" ? entry.call : entry.put }, implied),
    }));
}

export interface LadderNote {
  tone: "info" | "warn";
  text: string;
}

/** What is missing or odd in the ladder, in words. */
export function ladderNotes(rows: LadderRow[]): LadderNote[] {
  const notes: LadderNote[] = [];
  const unquoted = rows.filter((row) => row.cost.quote === null).length;
  if (unquoted > 0) {
    notes.push({
      tone: "info",
      text: `${unquoted} of the ${rows.length} strikes have no two-sided quote (a positive bid and an ask) and show no derived figures: an unquoted contract is unknown, not cheap.`,
    });
  }
  const crossed = rows.filter((row) => row.cost.belowIntrinsic).length;
  if (crossed > 0) {
    notes.push({
      tone: "warn",
      text: `${crossed} strike${crossed === 1 ? " has" : "s have"} an ask below intrinsic value (a stale or crossed quote), so its hurdle is not meaningful.`,
    });
  }
  return notes;
}

export const STRIKE_LADDER_DEFINITIONS = {
  sameFigures: "Each row is the single-contract card for that strike, at the same stored snapshot: bought at the ask, per unit of the underlying.",
  notRanked: "Nothing is ranked or marked best. Across strikes the spread, the move the index needs and theta's share of the premium do not improve together (on one stored BANKNIFTY chain the round-trip share of the ask for calls ran from under 1% to over 11%, widest at the far ends but with a wide strike in the middle too), so which mix suits a view is the reader's call.",
  spread: "Round trip: buying at the ask and selling at the bid straight away loses this share of the ask.",
  needed: "How far the index has to move from here to reach the breakeven at expiry, in points, and in multiples of the expected absolute day (a range over the two day-count conventions).",
} as const;
