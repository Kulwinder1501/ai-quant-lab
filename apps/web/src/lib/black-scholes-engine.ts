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
