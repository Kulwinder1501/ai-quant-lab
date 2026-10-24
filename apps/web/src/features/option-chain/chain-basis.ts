/**
 * What the Model greeks tab stands on: how much of the stored chain it can use. Pure, no React.
 *
 * Every figure on that tab (the Greeks by strike, the implied move, the contract cost card, the strike ladder, the payoff) is read
 * from ONE stored snapshot, and each needs different parts of it: a two-sided quote, a solved implied volatility, an ATM pair. A
 * chain with half its strikes unquoted still draws a tidy table. This module counts what is there and says, for each panel, whether
 * it has enough to stand on, by rules stated here and shown on the page, so a reader sees "the ladder rests on 31 of 62 contracts"
 * next to the ladder rather than discovering it from the dashes.
 *
 * The thresholds are conventions, not statistics: a share of two-sided quotes of 80% or more is "enough", 50% or more "partial", less
 * "thin". They say how much of the chain a panel can show, not whether what it shows is right.
 */
import type { StrikeRow } from "./live-chain";

export interface ChainBasisInput {
  strikes: readonly Pick<StrikeRow, "strikePrice" | "call" | "put">[];
  atmStrike: number | null;
  atmImpliedVolatility: number | null;
}

export interface ChainBasis {
  strikeCount: number;
  strikeLow: number | null;
  strikeHigh: number | null;
  /** Contracts that exist in the stored snapshot (a strike with no put has one leg, not two). */
  legs: number;
  /** A positive bid and an ask not below it. */
  twoSided: number;
  /** An implied volatility was solved from the mid. */
  ivSolved: number;
  /** Why the rest were not solved, by the broker-free reason code, largest first. */
  ivRefusals: Array<{ reason: string; count: number }>;
  /** Legs carrying Fyers' own Greeks beside the model ones (stored from the 2026-10-24 deploy onward). */
  vendorGreeks: number;
  atm: { strike: number | null; callTwoSided: boolean; putTwoSided: boolean; ivSolved: boolean };
}

type LegLike = { bid: number | null; ask: number | null; impliedVolatility: number | null; impliedVolatilityRefusal: string | null; vendorGreeks?: unknown } | null;

function isTwoSided(leg: LegLike): boolean {
  if (!leg || leg.bid === null || leg.ask === null) return false;
  return Number.isFinite(leg.bid) && Number.isFinite(leg.ask) && leg.bid > 0 && leg.ask >= leg.bid;
}

export function buildChainBasis(input: ChainBasisInput): ChainBasis {
  const prices = input.strikes.map((row) => row.strikePrice);
  const refusals = new Map<string, number>();
  let legs = 0;
  let twoSided = 0;
  let ivSolved = 0;
  let vendorGreeks = 0;
  for (const row of input.strikes) {
    for (const leg of [row.call, row.put] as LegLike[]) {
      if (!leg) continue;
      legs += 1;
      if (isTwoSided(leg)) twoSided += 1;
      if (leg.impliedVolatility !== null && leg.impliedVolatility > 0) ivSolved += 1;
      else refusals.set(leg.impliedVolatilityRefusal ?? "UNSPECIFIED", (refusals.get(leg.impliedVolatilityRefusal ?? "UNSPECIFIED") ?? 0) + 1);
      if (leg.vendorGreeks) vendorGreeks += 1;
    }
  }
  const atmRow = input.atmStrike === null ? undefined : input.strikes.find((row) => row.strikePrice === input.atmStrike);
  return {
    strikeCount: input.strikes.length,
    strikeLow: prices.length > 0 ? Math.min(...prices) : null,
    strikeHigh: prices.length > 0 ? Math.max(...prices) : null,
    legs,
    twoSided,
    ivSolved,
    ivRefusals: [...refusals].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    vendorGreeks,
    atm: {
      strike: input.atmStrike,
      callTwoSided: isTwoSided(atmRow?.call ?? null),
      putTwoSided: isTwoSided(atmRow?.put ?? null),
      ivSolved: input.atmImpliedVolatility !== null && input.atmImpliedVolatility > 0,
    },
  };
}

export type SufficiencyLevel = "enough" | "partial" | "thin" | "cannot";

export interface Sufficiency {
  level: SufficiencyLevel;
  /** One clause saying what it rests on or what is missing. */
  text: string;
}

export const ENOUGH_SHARE = 0.8;
export const PARTIAL_SHARE = 0.5;

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

/** The implied move needs the ATM straddle (both ATM legs two-sided) and a solved ATM volatility. */
export function impliedMoveSufficiency(basis: ChainBasis): Sufficiency {
  const straddle = basis.atm.callTwoSided && basis.atm.putTwoSided;
  if (straddle && basis.atm.ivSolved) return { level: "enough", text: `the ${basis.atm.strike} straddle is quoted on both sides and its volatility is solved` };
  if (!straddle && !basis.atm.ivSolved) return { level: "cannot", text: "the ATM straddle has no two-sided quote and no ATM volatility was solved" };
  return straddle
    ? { level: "partial", text: "the straddle is quoted but no ATM volatility was solved, so there is no typical-move band" }
    : { level: "partial", text: "an ATM volatility was solved but the straddle is not quoted on both sides, so it is not shown" };
}

/** The ladder and the cost card need two-sided quotes; their breadth is the share of contracts that have one. */
export function quoteSufficiency(basis: ChainBasis): Sufficiency {
  if (basis.legs === 0) return { level: "cannot", text: "the stored chain has no contract" };
  const share = basis.twoSided / basis.legs;
  const text = `${basis.twoSided} of ${basis.legs} contracts have a two-sided quote (${percent(basis.twoSided, basis.legs)})`;
  if (share >= ENOUGH_SHARE) return { level: "enough", text };
  if (share >= PARTIAL_SHARE) return { level: "partial", text };
  return { level: "thin", text };
}

/** Theta, delta and gamma need a solved volatility; their breadth is the share of contracts that have one. */
export function greeksSufficiency(basis: ChainBasis): Sufficiency {
  if (basis.legs === 0) return { level: "cannot", text: "the stored chain has no contract" };
  const share = basis.ivSolved / basis.legs;
  const text = `a volatility is solved for ${basis.ivSolved} of ${basis.legs} contracts (${percent(basis.ivSolved, basis.legs)})`;
  if (share >= ENOUGH_SHARE) return { level: "enough", text };
  if (share >= PARTIAL_SHARE) return { level: "partial", text };
  return { level: "thin", text };
}

/** The chain's shape in a sentence: how many strikes, over what range, and what it holds. */
export function basisSentence(basis: ChainBasis): string {
  if (basis.strikeCount === 0) return "The stored chain holds no strike.";
  const range = `${basis.strikeCount} strikes from ${basis.strikeLow!.toLocaleString("en-IN")} to ${basis.strikeHigh!.toLocaleString("en-IN")}`;
  const vendor = basis.vendorGreeks > 0
    ? `Fyers' own Greeks are stored for ${basis.vendorGreeks} of them.`
    : "No Fyers Greeks are stored for this snapshot (they are collected from the 2026-10-24 deploy onward), so the model Greeks have nothing to be checked against.";
  const refused = basis.ivRefusals.length > 0
    ? ` Not solved: ${basis.ivRefusals.map((entry) => `${entry.count} ${entry.reason.toLowerCase().replace(/_/g, " ")}`).join(", ")}.`
    : "";
  return `One stored snapshot: ${range}, ${basis.legs} contracts.${refused} ${vendor}`;
}

export const CHAIN_BASIS_DEFINITIONS = {
  oneSnapshot: "Everything on this tab is read from one stored snapshot (live ticks are not merged), so every figure shares one observation time.",
  thresholds: "A panel that depends on a share of contracts is \"enough\" at 80% or more, \"partial\" at 50% or more and \"thin\" below that. These are conventions for how much of the chain a panel can show, not statistics and not a statement that what it shows is right.",
  twoSided: "A two-sided quote is a positive bid and an ask not below it. A contract without one has no price to pay, so the cost card and the ladder derive nothing from it.",
  implied: "The implied move needs the ATM call and put both quoted (the straddle) and a solved ATM volatility (the typical-move band).",
} as const;
