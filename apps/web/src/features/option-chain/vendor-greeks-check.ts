/**
 * How closely this repo's model Greeks agree with Fyers' own, across the stored chain. Pure, no React.
 *
 * Two independent routes to the same numbers: the model solves an implied volatility from each contract's mid and derives its Greeks
 * with Black-Scholes on the put-call-parity forward; Fyers sends its own IV, delta, gamma, theta and vega with the chain (`greeks=1`),
 * stored raw beside the quote. Neither is the truth, but they are not the same computation, so where they agree each is some evidence for
 * the other, and where they drift apart the reader has been told something about the solver, the quote or the provider.
 *
 * Differences are always **vendor minus model**, in the units both use. Units are lined up here and nowhere else: the model's IV is a
 * fraction and the provider's a percent; delta is per one point of the underlying, theta is premium per calendar day per unit, vega
 * is per one volatility point, for both.
 *
 * ## What is and is not judged
 * - **IV and delta** get a verdict against the range seen in the single probe of 2026-10-23 (NIFTY50, BANKNIFTY, SBIN, one request
 *   each, NIFTY within 150 points of the money): IV bias +0.05 volatility points with a worst case of 0.24, delta bias +0.002 with a
 *   worst case of 0.008. That probe is small, so the verdict says "within" or "beyond the range seen in the probe", never "correct".
 * - **Gamma** is sent to four decimals only, so two values are compared as equal when they differ by no more than half a unit of the
 *   last place (0.00005): the share of contracts within that is reported, not a difference statistic.
 * - **Theta** differs by construction: the provider's has no call/put carry term, so one value sits between the model's call and put
 *   (about 4 a day apart on the probe). Its difference is reported and not judged.
 * - **Vega** is reported and not judged: the probe gave a mean difference and no range to judge against.
 */
import type { GreeksStrikeInput, GreeksStrikeLegInput } from "./build-greeks-by-strike";

export type CheckMetric = "iv" | "delta" | "gamma" | "theta" | "vega";

export const CHECK_METRICS: readonly CheckMetric[] = ["iv", "delta", "gamma", "theta", "vega"];

/** The unit each metric is compared in. */
export const CHECK_UNITS: Record<CheckMetric, string> = {
  iv: "volatility points",
  delta: "per point of the index",
  gamma: "per point of the index, per point",
  theta: "premium per calendar day, per unit",
  vega: "premium per volatility point, per unit",
};

/** What the 2026-10-23 probe showed, vendor minus model: the bias and the worst single difference. */
export const PROBE_REFERENCE = {
  iv: { bias: 0.05, worst: 0.24 },
  delta: { bias: 0.002, worst: 0.008 },
} as const;

/** The provider's gamma has four decimals: values closer than half of the last one are the same number. */
export const GAMMA_ROUNDING = 0.00005;

/** A verdict allows the probe's worst case with margin, since the probe was small: twice the worst single difference seen. */
export const VERDICT_MARGIN = 2;

export interface MetricPair {
  model: number;
  vendor: number;
  /** vendor minus model, in the comparison units. */
  difference: number;
  strike: number;
  side: "CE" | "PE";
}

/** The comparable (both present) values of each metric for one leg, in common units. */
export function pairsForLeg(strike: number, side: "CE" | "PE", leg: GreeksStrikeLegInput | null): Partial<Record<CheckMetric, MetricPair>> {
  const vendor = leg?.vendorGreeks;
  if (!leg || !vendor) return {};
  const make = (model: number | null, vendorValue: number | null): MetricPair | undefined => (
    model !== null && vendorValue !== null && Number.isFinite(model) && Number.isFinite(vendorValue)
      ? { model, vendor: vendorValue, difference: vendorValue - model, strike, side }
      : undefined
  );
  const result: Partial<Record<CheckMetric, MetricPair>> = {};
  const set = (metric: CheckMetric, pair: MetricPair | undefined) => { if (pair) result[metric] = pair; };
  set("iv", make(leg.impliedVolatility !== null && leg.impliedVolatility > 0 ? leg.impliedVolatility * 100 : null, vendor.impliedVolatilityPercent));
  set("delta", make(leg.delta, vendor.delta));
  set("gamma", make(leg.gamma, vendor.gamma));
  set("theta", make(leg.theta, vendor.theta));
  set("vega", make(leg.vega, vendor.vega));
  return result;
}

export type Verdict = "within" | "beyond" | "not-judged";

export interface MetricAgreement {
  metric: CheckMetric;
  /** Contracts where both the model and the provider have a value. */
  compared: number;
  /** Mean of vendor minus model: a signed bias. */
  bias: number | null;
  meanAbsolute: number | null;
  /** The largest absolute difference and where it was. */
  worst: { difference: number; strike: number; side: "CE" | "PE" } | null;
  /** Gamma only: how many compared contracts differ by no more than the provider's rounding. */
  withinRounding: number | null;
  verdict: Verdict;
}

function verdictFor(metric: CheckMetric, bias: number, worstAbs: number): Verdict {
  if (metric !== "iv" && metric !== "delta") return "not-judged";
  const reference = PROBE_REFERENCE[metric];
  return Math.abs(bias) <= reference.worst && worstAbs <= reference.worst * VERDICT_MARGIN ? "within" : "beyond";
}

export interface AgreementSummary {
  /** Contracts in the chain, and how many of them carry any provider Greeks. */
  legs: number;
  legsWithVendor: number;
  metrics: MetricAgreement[];
}

export function summariseAgreement(strikes: readonly GreeksStrikeInput[]): AgreementSummary {
  const collected: Record<CheckMetric, MetricPair[]> = { iv: [], delta: [], gamma: [], theta: [], vega: [] };
  let legs = 0;
  let legsWithVendor = 0;
  for (const row of strikes) {
    for (const [side, leg] of [["CE", row.call], ["PE", row.put]] as const) {
      if (!leg) continue;
      legs += 1;
      if (leg.vendorGreeks) legsWithVendor += 1;
      const pairs = pairsForLeg(row.strikePrice, side, leg);
      for (const metric of CHECK_METRICS) {
        const pair = pairs[metric];
        if (pair) collected[metric].push(pair);
      }
    }
  }

  const metrics = CHECK_METRICS.map((metric): MetricAgreement => {
    const pairs = collected[metric];
    if (pairs.length === 0) return { metric, compared: 0, bias: null, meanAbsolute: null, worst: null, withinRounding: null, verdict: "not-judged" };
    const bias = pairs.reduce((sum, pair) => sum + pair.difference, 0) / pairs.length;
    const meanAbsolute = pairs.reduce((sum, pair) => sum + Math.abs(pair.difference), 0) / pairs.length;
    const worstPair = pairs.reduce((best, pair) => (Math.abs(pair.difference) > Math.abs(best.difference) ? pair : best));
    return {
      metric,
      compared: pairs.length,
      bias,
      meanAbsolute,
      worst: { difference: worstPair.difference, strike: worstPair.strike, side: worstPair.side },
      withinRounding: metric === "gamma" ? pairs.filter((pair) => Math.abs(pair.difference) <= GAMMA_ROUNDING + 1e-12).length : null,
      verdict: verdictFor(metric, bias, Math.abs(worstPair.difference)),
    };
  });
  return { legs, legsWithVendor, metrics };
}

function signed(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  const text = Math.abs(rounded).toFixed(digits);
  return rounded < 0 ? `−${text}` : rounded > 0 ? `+${text}` : text;
}

const DIGITS: Record<CheckMetric, number> = { iv: 2, delta: 4, gamma: 5, theta: 2, vega: 3 };

export function formatDifference(metric: CheckMetric, value: number | null): string {
  return value === null ? "–" : signed(value, DIGITS[metric]);
}

export function verdictText(agreement: MetricAgreement): string {
  if (agreement.compared === 0) return "no pair";
  if (agreement.metric === "gamma") return `${agreement.withinRounding} of ${agreement.compared} within the provider's rounding`;
  if (agreement.verdict === "within") return "within the range seen in the 2026-10-23 probe";
  if (agreement.verdict === "beyond") return "beyond the range seen in the 2026-10-23 probe";
  return agreement.metric === "theta" ? "differs by construction (no carry term); not judged" : "not judged";
}

/** What the comparison has, in a sentence: how many contracts carry provider Greeks, or why there is nothing to compare. */
export function coverageSentence(summary: AgreementSummary): string {
  if (summary.legs === 0) return "The stored chain holds no contract.";
  if (summary.legsWithVendor === 0) {
    return "No Fyers Greeks are stored for this snapshot, so there is nothing to compare. They are collected by the chain runs of the deployed collector, so the first weekday session fills them in.";
  }
  const missing = summary.legs - summary.legsWithVendor;
  return `Fyers' own Greeks are stored for ${summary.legsWithVendor} of ${summary.legs} contracts${missing > 0 ? ` (${missing} without: an unquoted contract, or one the provider sent none for)` : ""}.`;
}

export const VENDOR_CHECK_DEFINITIONS = {
  twoRoutes: "The model solves a volatility from each contract's mid and derives its Greeks with Black-Scholes on the put-call-parity forward. Fyers sends its own with the chain. They are not the same computation, so agreement is some evidence for each and a gap is a prompt to look; neither is the truth.",
  difference: "Every difference is the provider's value minus the model's, in the same units. The model's IV is a fraction and the provider's a percent; both are compared in volatility points.",
  verdict: "IV and delta are judged against the one probe taken on 2026-10-23 (three underlyings, one request each): IV bias +0.05 volatility points, worst 0.24; delta bias +0.002, worst 0.008. \"Within\" allows twice that worst case and a bias no larger than it. The probe was small, so \"within\" does not mean correct, and \"beyond\" does not mean wrong.",
  gamma: "The provider sends gamma to four decimals, so two values closer than 0.00005 are counted as the same. Its differences are not summarised because rounding dominates them.",
  theta: "The provider's theta has no call/put carry term: one value per strike that sits between the model's call and put (about 4 a day apart on the probe). The difference is shown and not judged.",
} as const;
