import type { AtmImpliedVolatilityResult } from "../../market-data/domain/atm-implied-volatility.js";

/**
 * Which implied volatility prices (and gates) the long straddle.
 *
 * India VIX is a 30-day IV read from the PRIOR daily close. Using it to price a 7-day contract
 * mixes a tenor (30d vs 7d) and a timestamp (yesterday's close vs now). Measured: chain ATM IV
 * minus the prior VIX close has median -1.4 vol points (p10/p90 -3.0/+1.6) -- not a rounding
 * error against a gate whose margin is a few percent of the implied move.
 *
 * So the chain's own ATM IV at the contract's expiry, from a fresh point-in-time snapshot (the
 * same snapshot instant the fill will be priced from), is preferred. VIX remains only as an
 * explicit, tagged fallback, and the result carries a warning that says what it is not.
 */

export type StraddleIvSource = "CHAIN_ATM_AT_EXPIRY" | "INDIA_VIX_30D_PRIOR_CLOSE";

/** The snapshot age ceiling the options-entry checks standardise on. */
export const MAXIMUM_CHAIN_SNAPSHOT_AGE_MINUTES = 20;

export interface StraddleImpliedVolatility {
  /** Decimal (0.14 = 14%). */
  impliedVolatility: number;
  source: StraddleIvSource;
  /** The chain snapshot instant for a chain-sourced IV; null for the VIX fallback. */
  observedAt: Date | null;
  /** Non-null whenever the number is not the contract's own tenor-matched, point-in-time IV. */
  tenorWarning: string | null;
}

/**
 * The India VIX fallback caveat. Stated once so every consumer (log line, trade-idea evidence,
 * rationale) carries identical words.
 */
export function vixTenorWarning(daysToExpiry: number | null): string {
  const tenor = daysToExpiry === null ? "an unknown-tenor" : `a ${daysToExpiry.toFixed(0)}-day`;
  return "IV source is India VIX: a 30-day implied volatility from the PRIOR daily close, used to price "
    + `${tenor} contract. Chain ATM IV minus prior-close VIX has median -1.4 vol points `
    + "(p10/p90 -3.0/+1.6), so a VIX-priced straddle is typically over-valued vs the contract's own "
    + "tenor-matched IV. The chain snapshot for this expiry was missing, stale, or unsolvable.";
}

export function selectStraddleImpliedVolatility(input: {
  /** ATM IV solved from the snapshot of the contract's expiry (`atmImpliedVolatility`), or null if none. */
  chain: AtmImpliedVolatilityResult | null;
  chainObservedAt: Date | null;
  now: Date;
  /** India VIX as a decimal, or null. */
  vix: number | null;
  /** Calendar days from `now` to the contract's expiry, for the warning text. */
  daysToExpiry: number | null;
  maximumSnapshotAgeMinutes?: number;
}): StraddleImpliedVolatility | null {
  const maximumAge = input.maximumSnapshotAgeMinutes ?? MAXIMUM_CHAIN_SNAPSHOT_AGE_MINUTES;
  if (input.chain !== null && input.chain.measurable && input.chainObservedAt !== null) {
    const ageMinutes = (input.now.getTime() - input.chainObservedAt.getTime()) / 60_000;
    // A snapshot from the future is not point-in-time knowledge either.
    if (ageMinutes >= 0 && ageMinutes <= maximumAge
      && Number.isFinite(input.chain.impliedVolatility) && input.chain.impliedVolatility > 0) {
      return {
        impliedVolatility: input.chain.impliedVolatility,
        source: "CHAIN_ATM_AT_EXPIRY",
        observedAt: input.chainObservedAt,
        tenorWarning: null,
      };
    }
  }
  if (input.vix !== null && Number.isFinite(input.vix) && input.vix > 0) {
    return {
      impliedVolatility: input.vix,
      source: "INDIA_VIX_30D_PRIOR_CLOSE",
      observedAt: null,
      tenorWarning: vixTenorWarning(input.daysToExpiry),
    };
  }
  return null;
}
