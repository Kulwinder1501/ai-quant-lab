import {
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
  type OptionType,
} from "@ai-quant-lab/pricing";
import { OPTION_TICK_SIZE } from "../../pricing/domain/option-tick.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";


export interface OptionBuyerFillInput {
  /** Directional idea side: LONG → buy CE, SHORT → buy PE. */
  ideaSide: TradeSide;
  underlyingEntry: number;
  underlyingStop: number;
  underlyingTarget: number;
  impliedVolatility: number;
  expiryDate: Date;
  now?: Date;
  riskFreeRate?: number;
  /**
   * The instrument's strike interval, from `instruments.strike_step`.
   *
   * Required rather than inferred. This used to fall back to
   * `underlyingEntry >= 20000 ? 50 : 100`, and since both NIFTY and BANKNIFTY trade
   * above 20,000, BANKNIFTY received a 50-point step and produced strikes that do not
   * exist on the exchange. Two indices in the same price range cannot be separated by
   * a price threshold, so the caller supplies the contract specification.
   */
  strikeStep: number;
  /** Optional options entry validation result (11-factor checklist). */
  validationResult?: { isValid: boolean; reasons: string[] };
  /**
   * The observed book for the contract being bought, when a fresh chain snapshot covers it.
   *
   * Without this the entry fill is the Black-Scholes premium, and the model was measurably
   * wrong: on a live BANKNIFTY 57700 CE it produced 770.22 against a quoted mid of 748.25,
   * so a position opened 2.9% underwater the instant it was marked -- Rs 329 on one lot,
   * entirely model error rather than market cost.
   *
   * `premium` is what the buyer actually pays. `impliedVolatility` is solved from the mid and
   * replaces the caller's IV for the stop and target repricing, so all three premiums sit on
   * one volatility surface: taking the entry from the market and the exits from a different
   * IV would reintroduce the same inconsistency at the other end of the trade.
   */
  observedFill?: {
    premium: number;
    impliedVolatility: number;
    source?: "OPTION_CHAIN_QUOTE" | "OPTION_PREMIUM_TICK_ASK";
    /**
     * The quoted bid at entry, which is the basis the *exits* are measured on.
     *
     * A long option is closed by selling into the bid, and `evaluate-open-paper-trades`
     * compares both barriers against the observed bid series. The barriers themselves were
     * Black-Scholes premiums carrying the IV solved from the mid, so they sat half a spread
     * above the series they are tested against: the bid reached a mid-basis stop before the
     * mid did, and had to clear an extra half-spread to reach a mid-basis target. Both errors
     * ran against the position, which is what made stops fire early and targets go unreached.
     *
     * Supplying the bid moves both barriers onto the bid basis so they are compared like with
     * like. Omit it only when no bid is observable; the barriers then stay on the model basis
     * and the old asymmetry returns, which `exitBasisOffset` in the result makes explicit.
     */
    bid?: number | null;
  };
}

/**
 * How far the premium risk-reward may drift from the underlying idea's own, as a ratio.
 *
 * Repricing an underlying setup into premium space does not preserve risk-reward, and it is not
 * supposed to: an option is convex, so an adverse move costs less premium than a favourable move
 * gains, and some drift is the contract behaving correctly. What is not correct is drift without
 * bound. Measured across the 19 positions closed on 2026-08-14, every idea carried an underlying
 * risk-reward of exactly 1.50 while the premium geometry ranged from 0.30 to 24.40 — one trade
 * risking Rs 42.83 to make Rs 12.69, another risking Rs 0.80 to make Rs 19.52. Neither is the
 * strategy's risk model; both are the mapping losing it.
 *
 * Three allows genuine convexity through and refuses the pathological end. It is deliberately a
 * ratio rather than an absolute band, because it has to hold for any idea's risk-reward, not just
 * the 1.50 this strategy currently emits.
 */
export const MAXIMUM_RISK_REWARD_DISTORTION = 3;

export interface OptionBuyerFill {
  optionType: OptionType;
  /** Paper trade side — always LONG for an option buyer. */
  side: "LONG";
  strike: number;
  fillPremium: number;
  /** Where the entry premium came from, so a trade record is never ambiguous about it. */
  fillSource: "OPTION_CHAIN_QUOTE" | "OPTION_PREMIUM_TICK_ASK" | "OPTION_MODEL";
  /** IV used for the entry greeks and both premium barriers. Persist this on the position. */
  impliedVolatility: number;
  stopPremium: number;
  targetPremium: number;
  /**
   * Premium added to both barriers to move them from the model's mid basis onto the bid basis
   * the exit evaluator measures against. Negative by construction when a bid was observed, since
   * the bid sits below the mid. Zero means no bid was available and the barriers remain on the
   * model basis — worth recording, because that is the case where a stop can still fire early.
   */
  exitBasisOffset: number;
  entryGreeks: OptionGreeks;
  timeToExpiryYears: number;
  underlyingEntryPrice: number;
}

/**
 * Maps an index directional idea onto an ATM option-buyer fill in premium space.
 * Stop/target are re-priced with the same strike/IV/expiry at the idea's
 * underlying stop and target levels so SL/TP evaluation stays in ₹ premium.
 */
export function mapIdeaToOptionBuyerFill(input: OptionBuyerFillInput): OptionBuyerFill {
  if (input.validationResult && !input.validationResult.isValid) {
    throw new Error(`Options entry checklist failed: ${input.validationResult.reasons.join(" | ")}`);
  }

  const now = input.now ?? new Date();
  const rate = input.riskFreeRate ?? RISK_FREE_RATE;
  const step = input.strikeStep;
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error("Strike step must be a positive number; read it from instruments.strike_step.");
  }
  const optionType: OptionType = input.ideaSide === "LONG" ? "CE" : "PE";
  const strike = nearestStrike(input.underlyingEntry, step);
  const T = yearsToExpiry(now, input.expiryDate);

  // One volatility for entry, stop and target. When the chain has been solved, that is the
  // market's own IV rather than the caller's estimate of it.
  const volatility = input.observedFill?.impliedVolatility ?? input.impliedVolatility;

  const entryGreeks = priceEuropeanOption({
    spot: input.underlyingEntry,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility,
    optionType,
  });
  const stopGreeks = priceEuropeanOption({
    spot: input.underlyingStop,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility,
    optionType,
  });
  const targetGreeks = priceEuropeanOption({
    spot: input.underlyingTarget,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility,
    optionType,
  });

  // The underlying levels must sit on the side the idea claims, or the repriced
  // premiums are meaningless. Caught here rather than absorbed, because a stop on the
  // wrong side of the entry is a caller error, not a market condition.
  const expectedStopBelow = input.ideaSide === "LONG";
  if (expectedStopBelow
    ? !(input.underlyingStop < input.underlyingEntry && input.underlyingEntry < input.underlyingTarget)
    : !(input.underlyingTarget < input.underlyingEntry && input.underlyingEntry < input.underlyingStop)) {
    throw new Error(
      `A ${input.ideaSide} idea needs its stop and target on opposite sides of the entry; `
      + `received entry ${input.underlyingEntry}, stop ${input.underlyingStop}, target ${input.underlyingTarget}.`,
    );
  }

  // The observed price a buyer pays, when there is one. The model premium is a fallback for
  // contracts no snapshot covers, not an equal alternative.
  const fillPremium = Math.max(
    OPTION_TICK_SIZE,
    input.observedFill?.premium ?? entryGreeks.premium,
  );

  // Move both barriers onto the basis they are actually tested against.
  //
  // The entry is the ask, the IV is solved from the mid, and the exit evaluator compares the
  // barriers against the observed *bid*. Leaving the barriers at their model (mid-basis) value
  // therefore tested them against a series running half a spread below them, which made the stop
  // trigger early and the target unreachable by the same amount, both against the position.
  // Shifting by (observed bid - model premium at entry spot) restores like-for-like comparison.
  //
  // Note this makes the *measured* risk-reward worse, not better: risk now spans ask-to-bid, so
  // it carries the full round-trip spread the position genuinely pays. That cost was always
  // being paid — it was just landing in the exit rather than being visible in the geometry.
  const observedBid = input.observedFill?.bid;
  const exitBasisOffset = observedBid != null
    && Number.isFinite(observedBid)
    && observedBid > 0
    ? observedBid - entryGreeks.premium
    : 0;

  const stopPremium = Math.max(OPTION_TICK_SIZE, stopGreeks.premium + exitBasisOffset);
  const targetPremium = Math.max(OPTION_TICK_SIZE, targetGreeks.premium + exitBasisOffset);

  // Black-Scholes premium is monotonic in spot, so with coherent inputs the ordering
  // always holds -- except when the option is so far out of the money, or so close to
  // expiry, that two of the three premiums collapse onto the tick floor. That is a real
  // and meaningful condition: the contract is effectively worthless, and no tradable
  // stop/target geometry exists in premium space.
  //
  // This used to synthesise one: a symmetric band of `abs(fill - stop)` or, failing
  // that, `fillPremium * 0.3`. That turned a worthless option into a setup that looked
  // tradable, with a 30%-of-premium risk nobody chose and no record that the model's
  // own output had been discarded. It now refuses.
  if (!(stopPremium < fillPremium && fillPremium < targetPremium)) {
    throw new Error(
      `Repricing gave no tradable premium geometry (stop ${stopPremium}, fill ${fillPremium}, `
      + `target ${targetPremium}) for the ${strike} ${optionType} at ${T.toFixed(4)}y to expiry. `
      + "The option is effectively worthless at these levels; widen the expiry or move the strike.",
    );
  }

  // The strategy's risk model must survive the trip into premium space. Ordering alone does not
  // check that: a setup risking Rs 42.83 to make Rs 12.69 satisfies stop < fill < target
  // perfectly well, and nine of the nineteen positions closed on 2026-08-14 would have been
  // refused here. Compared as a ratio against the idea's own risk-reward, so a strategy that
  // changes its geometry does not silently drift past this guard.
  const underlyingRisk = Math.abs(input.underlyingEntry - input.underlyingStop);
  const underlyingReward = Math.abs(input.underlyingTarget - input.underlyingEntry);
  const premiumRisk = fillPremium - stopPremium;
  const premiumReward = targetPremium - fillPremium;
  if (underlyingRisk > 0 && premiumRisk > 0) {
    const underlyingRiskReward = underlyingReward / underlyingRisk;
    const premiumRiskReward = premiumReward / premiumRisk;
    const distortion = premiumRiskReward / underlyingRiskReward;
    if (distortion > MAXIMUM_RISK_REWARD_DISTORTION
      || distortion < 1 / MAXIMUM_RISK_REWARD_DISTORTION) {
      throw new Error(
        `Repricing distorted the idea's risk-reward beyond ${MAXIMUM_RISK_REWARD_DISTORTION}x: `
        + `underlying ${underlyingRiskReward.toFixed(2)}:1 became premium `
        + `${premiumRiskReward.toFixed(2)}:1 (${distortion.toFixed(2)}x) for the ${strike} `
        + `${optionType}, risking ${premiumRisk.toFixed(2)} to make ${premiumReward.toFixed(2)}. `
        + "The premium geometry is not the strategy's risk model; move the strike or the expiry.",
      );
    }
  }

  return {
    optionType,
    side: "LONG",
    strike,
    fillPremium: roundMoney(fillPremium),
    fillSource: input.observedFill === undefined
      ? "OPTION_MODEL"
      : (input.observedFill.source ?? "OPTION_CHAIN_QUOTE"),
    impliedVolatility: volatility,
    stopPremium: roundMoney(stopPremium),
    targetPremium: roundMoney(targetPremium),
    exitBasisOffset: roundMoney(exitBasisOffset),
    entryGreeks,
    timeToExpiryYears: T,
    underlyingEntryPrice: input.underlyingEntry,
  };
}

/** 15:30 IST, the NSE close, expressed in UTC. */
const EXPIRY_HOUR_UTC = 10;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns a caller-supplied expiry into the instant the contract actually settles.
 *
 * `new Date("2026-08-04")` is midnight UTC, which is 05:30 IST — ten hours before the
 * 15:30 IST settlement. That is not a rounding difference: the expiry evaluator
 * force-closes as soon as `asOf >= expiry`, so a date-only expiry settled positions at
 * the *pre-open* of expiry day against the previous session's spot, discarding the whole
 * final trading day. It cost 64.40 per contract on the one option position that reached
 * expiry — settled at 142.80 off a mid-session 57,842.80 when the day closed at
 * 57,907.20, where intrinsic was 207.20.
 *
 * A date-only string therefore means "that day's close". A full timestamp is taken as
 * given, because a caller who supplied a time meant it.
 */
export function resolveOptionExpiryInstant(input: string): Date {
  const trimmed = input.trim();
  if (DATE_ONLY.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const instant = new Date(Date.UTC(year, month - 1, day, EXPIRY_HOUR_UTC, 0, 0, 0));
    // Date.UTC rolls impossible dates over (month 13, day 32), which would silently price
    // a contract on a day the caller did not name.
    if (
      instant.getUTCFullYear() !== year
      || instant.getUTCMonth() !== month - 1
      || instant.getUTCDate() !== day
    ) {
      return new Date(NaN);
    }
    return instant;
  }
  return new Date(trimmed);
}

/**
 * The next weekly expiry at 15:30 IST for an instrument that expires on `weekday`,
 * **including today when today is expiry day and the close has not passed**.
 *
 * The previous implementation computed `(4 - day + 7) % 7 || 7`, so on a Thursday the
 * `|| 7` turned today's zero-day offset into a full week. Every trade opened on expiry
 * morning was then priced against a contract seven days out, which overstates the
 * premium and understates theta by the entire week that matters most.
 *
 * `weekday` is required and has no default. It belongs to the instrument
 * (`instruments.weekly_expiry_weekday`), because NSE has consolidated weekly expiries
 * so the day is neither fixed nor shared across indices — and because an instrument may
 * have no weekly series at all, which a default cannot express. An instrument whose
 * weekday is unset has no inferable weekly expiry, and callers must be given an explicit
 * one rather than have this function invent a contract.
 *
 * Renamed from `defaultWeeklyExpiry`: nothing about it is a default any more.
 */
export function nextWeeklyExpiry(from: Date, weekday: number): Date {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("Expiry weekday must be an integer from 0 (Sunday) to 6 (Saturday).");
  }
  const expiryToday = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    EXPIRY_HOUR_UTC,
    0,
    0,
    0,
  );
  // Today counts only while its close is still ahead; once 15:30 IST passes, that
  // series has settled and the next one is a week out.
  const isExpiryDayStillOpen = from.getUTCDay() === weekday && from.getTime() < expiryToday;
  const daysAhead = isExpiryDayStillOpen ? 0 : ((weekday - from.getUTCDay() + 7) % 7) || 7;

  return new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate() + daysAhead,
    EXPIRY_HOUR_UTC,
    0,
    0,
    0,
  ));
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
