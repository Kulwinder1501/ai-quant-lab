/**
 * Option pricing, shared by the API and the web client.
 *
 * This lives in a package because it was duplicated. `apps/web/src/lib` held a copy of both
 * the engine and the IV solver, and every pricing fix made during 2026-08 landed in the API
 * copy only -- so the browser kept re-solving greeks against raw spot while the server had
 * moved to the put-call-parity forward. On a live BANKNIFTY 57700 CE that is a delta of 0.61
 * against 0.53, and it appeared as the number changing the moment a tick arrived.
 *
 * Deliberately one file. Both consumers read this TypeScript source directly -- the API under
 * NodeNext, the web app under a bundler -- and those two disagree about whether a relative
 * import needs a `.js` extension. With no internal relative imports there is nothing to
 * disagree about.
 *
 * Keep framework, database and HTTP imports out of here, as with `@ai-quant-lab/contracts`.
 */

// ---------------------------------------------------------------- shared constants

export const RISK_FREE_RATE = 0.065;

// ------------------------------------------------------------ Black-Scholes engine

/**
 * Black–Scholes–Merton European option pricer with first-order Greeks.
 *
 * NSE index options (NIFTY / BANKNIFTY) are European-style, so this closed form
 * is the right theoretical engine when a live options chain is unavailable.
 * Implied volatility is expected as a decimal (e.g. India VIX 12.5 → 0.125).
 */

export type OptionType = "CE" | "PE";

export interface BlackScholesInput {
  /** Spot / underlying price. */
  spot: number;
  /** Strike. */
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Continuously compounded risk-free rate (decimal). */
  riskFreeRate: number;
  /** Implied volatility (decimal). */
  volatility: number;
  optionType: OptionType;
}

export interface OptionGreeks {
  premium: number;
  delta: number;
  gamma: number;
  /** Calendar-day theta in currency units (premium change per day). */
  theta: number;
  /** Vega per 1% absolute IV move. */
  vega: number;
  intrinsicValue: number;
  timeValue: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const DAYS_PER_YEAR = 365;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundGreek(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

/** Standard normal PDF. */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Abramowitz & Stegun 26.2.17 rational approximation of the standard normal CDF.
 * Absolute error < 7.5e-8 — enough for premium rounding to paise.
 */
function normCdf(x: number): number {
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * absX);
  const poly = t * (0.319381530
    + t * (-0.356563782
      + t * (1.781477937
        + t * (-1.821255978
          + t * 1.330274429))));
  const approx = 1 - normPdf(absX) * poly;
  return x >= 0 ? approx : 1 - approx;
}

function intrinsicValue(spot: number, strike: number, optionType: OptionType): number {
  if (optionType === "CE") return Math.max(0, spot - strike);
  return Math.max(0, strike - spot);
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
}

/**
 * Prices a European call/put and returns premium + Greeks.
 * When `T ≤ 0` or `σ ≤ 0`, returns intrinsic value only with zero Greeks.
 */
export function priceEuropeanOption(input: BlackScholesInput): OptionGreeks {
  assertPositiveFinite(input.spot, "Spot");
  assertPositiveFinite(input.strike, "Strike");
  if (!Number.isFinite(input.riskFreeRate)) {
    throw new Error("Risk-free rate must be finite.");
  }
  if (input.optionType !== "CE" && input.optionType !== "PE") {
    throw new Error("Option type must be CE or PE.");
  }

  const intrinsic = intrinsicValue(input.spot, input.strike, input.optionType);
  const T = input.timeToExpiryYears;
  const sigma = input.volatility;

  if (!Number.isFinite(T) || T <= 0 || !Number.isFinite(sigma) || sigma <= 0) {
    return {
      premium: roundMoney(intrinsic),
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      intrinsicValue: roundMoney(intrinsic),
      timeValue: 0,
    };
  }

  // Numerical floor: sub-minute expiries blow up 1/√T; treat as near-expiry limit.
  const time = Math.max(T, 1 / (DAYS_PER_YEAR * 24 * 60));
  const sqrtT = Math.sqrt(time);
  const { spot: S, strike: K, riskFreeRate: r } = input;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * time) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const discount = Math.exp(-r * time);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nMinusD1 = normCdf(-d1);
  const nMinusD2 = normCdf(-d2);
  const pdfD1 = normPdf(d1);

  let premium: number;
  let delta: number;
  let thetaAnnual: number;

  if (input.optionType === "CE") {
    premium = S * nd1 - K * discount * nd2;
    delta = nd1;
    thetaAnnual = -(S * pdfD1 * sigma) / (2 * sqrtT) - r * K * discount * nd2;
  } else {
    premium = K * discount * nMinusD2 - S * nMinusD1;
    delta = nd1 - 1;
    thetaAnnual = -(S * pdfD1 * sigma) / (2 * sqrtT) + r * K * discount * nMinusD2;
  }

  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vegaPerPercent = (S * pdfD1 * sqrtT) / 100;
  const thetaPerDay = thetaAnnual / DAYS_PER_YEAR;
  const roundedPremium = roundMoney(Math.max(0, premium));
  const roundedIntrinsic = roundMoney(intrinsic);

  return {
    premium: roundedPremium,
    delta: roundGreek(delta),
    gamma: roundGreek(gamma),
    theta: roundGreek(thetaPerDay),
    vega: roundGreek(vegaPerPercent),
    intrinsicValue: roundedIntrinsic,
    timeValue: roundMoney(Math.max(0, roundedPremium - roundedIntrinsic)),
  };
}

/** Years between two timestamps (calendar, 365-day year). Negative → 0. */
export function yearsToExpiry(now: Date, expiryDate: Date): number {
  const ms = expiryDate.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
}

/** Round a spot to the nearest strike step (NIFTY 50 / BANKNIFTY 100 typical). */
export function nearestStrike(spot: number, step: number): number {
  assertPositiveFinite(spot, "Spot");
  assertPositiveFinite(step, "Strike step");
  return Math.round(spot / step) * step;
}

// -------------------------------------------------- implied volatility and forwards

/**
 * Recovers implied volatility from an observed option premium.
 *
 * The chain provider quotes prices but not IV, so it has to be solved for. This is a
 * derived quantity and is labelled as one everywhere it surfaces: it is the volatility
 * that *would* reproduce the observed premium under Black-Scholes, not a number the
 * exchange published.
 *
 * Every failure mode returns a reason rather than a number. An unsolvable premium is
 * common and informative — an expired contract, a one-sided market, a stale quote below
 * intrinsic — and substituting a plausible IV would put a fabricated volatility onto a
 * screen a trade decision reads.
 */

export type ImpliedVolatilityRefusal =
  | "EXPIRED_OR_ZERO_TIME"
  | "NO_PREMIUM"
  | "BELOW_INTRINSIC"
  | "ABOVE_UPPER_BOUND"
  | "EXTRINSIC_BELOW_PRICE_RESOLUTION"
  | "DID_NOT_CONVERGE";

export type ImpliedVolatilityResult =
  | { measurable: true; impliedVolatility: number; iterations: number }
  | { measurable: false; reason: ImpliedVolatilityRefusal; explanation: string };

export interface ImpliedVolatilityInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  optionType: OptionType;
  /** The observed premium to invert. Prefer the mid of a two-sided quote. */
  premium: number;
}

/** Widest band the solver will search: 0.01% to 500% annualised. */
const MINIMUM_VOLATILITY = 0.0001;
const MAXIMUM_VOLATILITY = 5.0;
const PRICE_TOLERANCE = 1e-6;
const MAXIMUM_ITERATIONS = 100;

/**
 * The smallest extrinsic value an IV can honestly be solved from.
 *
 * All volatility information in a premium lives in its extrinsic part, and quotes arrive
 * rounded — the pricing engine to 0.01, NSE itself to a 0.05 tick. Measured on a deep
 * in-the-money NIFTY strike: premium 6067.19, intrinsic 6067.1894, so extrinsic 0.0006
 * against a 0.01 quantum. The rounding is roughly seventeen times the whole signal, and
 * the solver still returned a confident-looking 0.2826 for a true 0.22.
 *
 * That is the dangerous failure: not a refusal, but a plausible number with nothing
 * behind it, rendered next to genuine IVs on a screen a trade decision reads. One tick is
 * the floor below which the premium simply does not resolve volatility.
 */
const MINIMUM_EXTRINSIC_FOR_IV = 0.05;

function refuse(reason: ImpliedVolatilityRefusal, explanation: string): ImpliedVolatilityResult {
  return { measurable: false, reason, explanation };
}

/**
 * No-arbitrage bounds for a European option.
 *
 * A premium outside them cannot be produced by any volatility, so the solver must not be
 * asked to find one. In practice this catches stale or crossed quotes rather than genuine
 * arbitrage, which is exactly why it is reported instead of clamped.
 */
function priceBounds(input: ImpliedVolatilityInput): { lower: number; upper: number } {
  const discountedStrike = input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears);
  return input.optionType === "CE"
    ? { lower: Math.max(0, input.spot - discountedStrike), upper: input.spot }
    : { lower: Math.max(0, discountedStrike - input.spot), upper: discountedStrike };
}

/**
 * Solves for volatility by Newton-Raphson on vega, falling back to bisection.
 *
 * Newton converges in a handful of steps near the money, where vega is large. It becomes
 * unreliable in the wings — vega there approaches zero, so a Newton step divides by
 * almost nothing and can leap out of the search band. Bisection is slower but cannot
 * diverge, so a bracketed bisection backs it up rather than reporting a wing contract as
 * unsolvable.
 */
export function impliedVolatilityFromPremium(input: ImpliedVolatilityInput): ImpliedVolatilityResult {
  const { spot, strike, timeToExpiryYears, riskFreeRate, optionType, premium } = input;

  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(strike) || strike <= 0) {
    return refuse("NO_PREMIUM", "Spot and strike must both be positive to invert a premium.");
  }
  // Time is floored to zero once expiry passes, and at T=0 an option is worth exactly its
  // intrinsic value for *every* volatility, so nothing is recoverable. Observed live: a
  // NIFTY chain still listed its same-day expiry nearly three hours after that expiry.
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) {
    return refuse(
      "EXPIRED_OR_ZERO_TIME",
      "The contract has expired or has no time left, so its premium is intrinsic value and no "
      + "volatility can be recovered from it.",
    );
  }
  if (!Number.isFinite(premium) || premium <= 0) {
    return refuse("NO_PREMIUM", "No positive premium was observed, so there is nothing to invert.");
  }

  const bounds = priceBounds(input);
  if (premium < bounds.lower - PRICE_TOLERANCE) {
    return refuse(
      "BELOW_INTRINSIC",
      `The premium ${premium.toFixed(4)} is below the no-arbitrage floor ${bounds.lower.toFixed(4)}, `
      + "which no volatility can produce. Usually a stale or crossed quote rather than arbitrage.",
    );
  }
  if (premium > bounds.upper + PRICE_TOLERANCE) {
    return refuse(
      "ABOVE_UPPER_BOUND",
      `The premium ${premium.toFixed(4)} exceeds the no-arbitrage ceiling ${bounds.upper.toFixed(4)}.`,
    );
  }

  // Guarded before any iteration: the solver would happily converge on a rounded price
  // and return a number that describes the rounding rather than the market.
  const extrinsic = premium - bounds.lower;
  if (extrinsic < MINIMUM_EXTRINSIC_FOR_IV) {
    return refuse(
      "EXTRINSIC_BELOW_PRICE_RESOLUTION",
      `Only ${extrinsic.toFixed(4)} of this ${premium.toFixed(2)} premium is extrinsic, below the `
      + `${MINIMUM_EXTRINSIC_FOR_IV} floor one price tick allows. All volatility information lives in `
      + "the extrinsic part, so a solved IV here would describe the price rounding, not the market.",
    );
  }

  const priceAt = (volatility: number): number => priceEuropeanOption({
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    volatility,
    optionType,
  }).premium;

  // Bracket first: if the premium sits outside what the widest band can produce, no
  // amount of iterating will find it, and saying so beats returning a boundary value.
  const lowPrice = priceAt(MINIMUM_VOLATILITY);
  const highPrice = priceAt(MAXIMUM_VOLATILITY);
  if (premium < lowPrice - PRICE_TOLERANCE) {
    return refuse(
      "BELOW_INTRINSIC",
      `The premium implies a volatility under ${(MINIMUM_VOLATILITY * 100).toFixed(2)}%, below the `
      + "search band. Treated as unmeasurable rather than reported as the floor.",
    );
  }
  if (premium > highPrice + PRICE_TOLERANCE) {
    return refuse(
      "ABOVE_UPPER_BOUND",
      `The premium implies a volatility over ${(MAXIMUM_VOLATILITY * 100).toFixed(0)}%, above the `
      + "search band. Treated as unmeasurable rather than reported as the ceiling.",
    );
  }

  // Newton-Raphson, seeded by a Brenner-Subrahmanyam style ATM approximation.
  let volatility = Math.min(
    MAXIMUM_VOLATILITY,
    Math.max(MINIMUM_VOLATILITY, (premium / spot) * Math.sqrt((2 * Math.PI) / timeToExpiryYears)),
  );
  for (let iteration = 1; iteration <= MAXIMUM_ITERATIONS; iteration += 1) {
    const greeks = priceEuropeanOption({
      spot, strike, timeToExpiryYears, riskFreeRate, volatility, optionType,
    });
    const difference = greeks.premium - premium;
    if (Math.abs(difference) < PRICE_TOLERANCE) {
      return { measurable: true, impliedVolatility: volatility, iterations: iteration };
    }
    // `vega` is reported per 1% of IV, so it is scaled back to a per-unit derivative.
    const vegaPerUnit = greeks.vega * 100;
    if (!Number.isFinite(vegaPerUnit) || Math.abs(vegaPerUnit) < 1e-10) break;
    const next = volatility - difference / vegaPerUnit;
    if (!Number.isFinite(next) || next <= MINIMUM_VOLATILITY || next >= MAXIMUM_VOLATILITY) break;
    if (Math.abs(next - volatility) < 1e-12) {
      return { measurable: true, impliedVolatility: next, iterations: iteration };
    }
    volatility = next;
  }

  // Bisection fallback. Cannot diverge, and the bracket was already proven above.
  let low = MINIMUM_VOLATILITY;
  let high = MAXIMUM_VOLATILITY;
  for (let iteration = 1; iteration <= MAXIMUM_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    const difference = priceAt(middle) - premium;
    if (Math.abs(difference) < PRICE_TOLERANCE || high - low < 1e-9) {
      return { measurable: true, impliedVolatility: middle, iterations: MAXIMUM_ITERATIONS + iteration };
    }
    if (difference > 0) high = middle;
    else low = middle;
  }

  return refuse(
    "DID_NOT_CONVERGE",
    "Neither Newton-Raphson nor bisection reached the premium within the iteration budget.",
  );
}

/**
 * The mid of a two-sided quote, which is the price IV should be solved from.
 *
 * Returns null for a one-sided market instead of falling back to the last traded price.
 * A last price can be hours stale on an illiquid strike, and an IV derived from it would
 * look identical to one derived from a live market while describing a different moment.
 */
export function midPriceForIv(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;
  return (bid + ask) / 2;
}

export interface ParityPair {
  strike: number;
  /** Mid of the call at this strike. */
  callMid: number;
  /** Mid of the put at the same strike and expiry. */
  putMid: number;
}

/**
 * The forward the option market itself is pricing, recovered from put-call parity.
 *
 * Black-Scholes on spot with only a risk-free rate assumes a forward of `S*e^(rT)`, which
 * is wrong for an index whose constituents pay dividends: the real forward sits *below*
 * spot, not above. Measured on a live BANKNIFTY chain — spot 57,907, r-only forward
 * ~58,118, parity-implied forward ~57,712. A 406-point error, 0.7% of spot, and it showed
 * up as a 7.5 percentage-point gap between call IV (9.00%) and put IV (16.52%) at the
 * same strike, which put-call parity forbids.
 *
 * Deriving the forward removes the carry assumption entirely: the market states its own.
 * `F = (C - P)/e^(-rT) + K` for any strike where both legs are quoted two-sided.
 *
 * The **median** across strikes, not the mean, because one stale quote in the set would
 * drag an average while leaving a median untouched. On the live chain the per-strike
 * estimates spanned 57,710 to 57,717 — a seven-point spread on a 57,700 strike — so the
 * quantity is well determined and disagreement is a quote problem, not a modelling one.
 */
export function impliedForwardFromParity(
  pairs: readonly ParityPair[],
  riskFreeRate: number,
  timeToExpiryYears: number,
): number | null {
  if (timeToExpiryYears <= 0 || !Number.isFinite(timeToExpiryYears)) return null;
  const discount = Math.exp(-riskFreeRate * timeToExpiryYears);
  const forwards: number[] = [];
  for (const pair of pairs) {
    if (!Number.isFinite(pair.strike) || pair.strike <= 0) continue;
    if (!Number.isFinite(pair.callMid) || !Number.isFinite(pair.putMid)) continue;
    if (pair.callMid <= 0 || pair.putMid <= 0) continue;
    const forward = (pair.callMid - pair.putMid) / discount + pair.strike;
    if (Number.isFinite(forward) && forward > 0) forwards.push(forward);
  }
  if (forwards.length === 0) return null;
  forwards.sort((left, right) => left - right);
  const middle = Math.floor(forwards.length / 2);
  return forwards.length % 2 === 1
    ? forwards[middle]!
    : (forwards[middle - 1]! + forwards[middle]!) / 2;
}

/**
 * The spot to feed a Black-Scholes call so it reproduces a given forward.
 *
 * BS-on-spot implies `forward = spot*e^(rT)`, so passing `F*e^(-rT)` makes the model's
 * own forward equal `F` exactly. This is how a forward-consistent IV is obtained without
 * replacing the pricing engine with a Black-76 variant.
 */
export function effectiveSpotForForward(
  forward: number,
  riskFreeRate: number,
  timeToExpiryYears: number,
): number {
  return forward * Math.exp(-riskFreeRate * timeToExpiryYears);
}
