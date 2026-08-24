import { netOutcomeR, roundTripCostR } from "../../../backtesting/domain/round-trip-cost.js";

/**
 * Canonical friction sensitivity for the scalp research harness — and emphatically *not* an option
 * execution cost model.
 *
 * ## The distinction this module exists to keep visible
 *
 * There are two separate questions behind "are our targets realistic", and collapsing them has already
 * cost this project one round of planning:
 *
 *   **Track A / underlying** — does the signal select moments whose subsequent move is large enough to
 *   matter, once ordinary friction is charged against the *underlying* bracket?
 *
 *   **Track B / premium** — can that move be monetised through an actual option contract, at the ask on
 *   the way in and the bid on the way out, after fees and adverse fills?
 *
 * This module answers only the first. It reuses `roundTripCostR`, whose own documentation is explicit
 * that it folds brokerage, STT, exchange charges, GST, SEBI fees and stamp duty into a single
 * basis-point figure because its purpose is *relative comparison*, carrying uncertainty through a
 * ladder rather than an asserted fee table.
 *
 * Applying it to option premium would be wrong twice over: an option's spread is a percentage of
 * *premium*, not of underlying notional, and is far wider than any rung here; and premium movement is
 * not underlying movement once implied volatility and delta are involved. Track B has its own machinery
 * in `d2-premium-cost-gate` and must not be approximated by these numbers.
 *
 * So every report that quotes a figure from this module is required to carry
 * `costModel: canonicalFrictionModel` alongside it. A reader who sees "net of 2 bps" without that label
 * will reasonably assume it means "net of what we actually pay to trade", and it does not.
 *
 * ## Why a ladder and not a point estimate
 *
 * A single cost number is a free parameter, and a free parameter in a cost model is worth more to a
 * strategy's apparent viability than almost any other choice available. The rungs are reported
 * together so the reader sees the whole sensitivity surface, and a strategy that survives 1 bps but
 * dies at 2 is correctly read as economically fragile rather than as a winner.
 *
 * ## The cancellation that matters for interpretation
 *
 * Signal Edge is `selected - mean(controls)`. Both sides pay friction, so cost *largely cancels* in
 * that difference and a friction rung will barely move it. That is not a defect — it is the correct
 * behaviour, and it is why the friction gate is a separate stage from the gross-edge gate. Friction
 * decides whether an established edge is *tradeable*; it cannot decide whether an edge exists. Reading
 * a near-unchanged Signal Edge across rungs as "costs don't hurt us" inverts the meaning.
 */

/** Stamped onto every friction-adjusted figure, so a later change to the rungs is detectable. */
export const canonicalFrictionPolicyVersion = "SCALP_CANONICAL_FRICTION_V1";

/**
 * The label every report must carry beside a net figure produced here.
 *
 * Spelled out rather than left to the reader because the failure mode is silent: a net-of-cost number
 * quoted without it reads as native trading economics.
 */
export const canonicalFrictionModel =
  "CANONICAL_UNDERLYING_FRICTION — basis points of underlying notional, charged twice. "
  + "Sensitivity instrument for relative comparison only. NOT option execution economics; "
  + "premium spread, fees and IV/delta effects are out of scope and are Track B's concern.";

/** One-way cost rungs in basis points of underlying notional. Charged on both entry and exit. */
export const canonicalFrictionRungsBps = [1, 2, 5] as const;

export type CanonicalFrictionRungBps = typeof canonicalFrictionRungsBps[number];

export interface FrictionGeometry {
  /** The price the round trip is charged against. */
  readonly entryFillPrice: number;
  /** Planned risk distance, entry to stop, in price. The denominator of an R multiple. */
  readonly plannedRiskPerUnit: number;
}

/**
 * Round-trip friction expressed in risk units, for one rung.
 *
 * Returns null rather than throwing when the geometry cannot support the conversion — a settled row
 * with no fill price or a degenerate stop distance is a data condition, not a programming error, and
 * the caller excludes it the same way it excludes an ungradeable outcome.
 */
export function frictionR(geometry: FrictionGeometry, oneWayCostBps: number): number | null {
  if (!Number.isFinite(geometry.entryFillPrice) || geometry.entryFillPrice <= 0) return null;
  if (!Number.isFinite(geometry.plannedRiskPerUnit) || geometry.plannedRiskPerUnit <= 0) return null;
  if (!Number.isFinite(oneWayCostBps) || oneWayCostBps < 0) return null;
  return roundTripCostR({
    riskPerUnit: geometry.plannedRiskPerUnit,
    entryPrice: geometry.entryFillPrice,
    costBps: oneWayCostBps,
  });
}

/**
 * Gross R less round-trip friction, for one rung. Null when either input is unusable.
 *
 * A null gross outcome stays null: an ungradeable settlement does not become gradeable by having a
 * cost subtracted from it.
 */
export function netR(
  grossR: number | null,
  geometry: FrictionGeometry,
  oneWayCostBps: number,
): number | null {
  if (grossR === null || !Number.isFinite(grossR)) return null;
  if (frictionR(geometry, oneWayCostBps) === null) return null;
  return netOutcomeR({
    grossR,
    riskPerUnit: geometry.plannedRiskPerUnit,
    entryPrice: geometry.entryFillPrice,
    costBps: oneWayCostBps,
  });
}

/**
 * Gross return in basis points less round-trip friction, for one rung.
 *
 * Exact and geometry-free: the round trip is charged twice, so the whole adjustment is `-2 x rung`.
 * Reported alongside the R figures because bps is comparable across instruments in a way R is not —
 * an R multiple is denominated in that subject's own stop distance, so a NIFTY50 R and a BANKNIFTY R
 * are not the same quantity of money.
 */
export function netBps(grossBps: number | null, oneWayCostBps: number): number | null {
  if (grossBps === null || !Number.isFinite(grossBps)) return null;
  if (!Number.isFinite(oneWayCostBps) || oneWayCostBps < 0) return null;
  return Number((grossBps - 2 * oneWayCostBps).toFixed(6));
}
