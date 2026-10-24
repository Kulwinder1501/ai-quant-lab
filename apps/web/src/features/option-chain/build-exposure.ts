/**
 * Gamma and theta exposure of the open interest on one expiry's chain. Pure, no React.
 *
 * Three different kinds of number live here, and the screen keeps them apart:
 *
 * 1. **Observed x model, no assumption about who holds what.** Gamma-weighted OI (`gamma x OI`) and OI-weighted theta
 *    (`-theta x OI`) per strike and side. OI is the exchange's (underlying units, not lots); gamma and theta are
 *    Black-Scholes values at the leg's solved IV, from the same engine as the Greeks tab. They describe what *all* of the
 *    open interest would do if it were held long. They do not say who holds it.
 * 2. **An estimate that rests on an assumption.** Net gamma exposure needs the sign of each side's position, and open interest
 *    does not carry it: for every contract someone is long and someone is short, and the data does not say whether dealers
 *    or customers are on which side. A net figure therefore needs a stated convention. `convention: "calls-long"` (the usual
 *    one: net = call exposure - put exposure) and its mirror are both offered, neither is observed, and the result flips sign
 *    with the choice. It is a model of positioning, not a measurement of it.
 * 3. **A sweep over hypothetical spots.** The net exposure re-priced at spots from -4% to +4%, and where it changes sign (the
 *    "flip"). Each leg keeps its solved IV and the forward moves with the spot in proportion, exactly as `live-chain.ts` carries
 *    a snapshot forward to a live spot. IVs do not move with spot here, which real markets do not respect: a smile that
 *    shifts as spot moves would move the flip. The flip is the most assumption-laden number on the screen.
 *
 * ## Units
 * - `gammaOi`: gamma x OI. Change in the OI's total delta, in underlying units, per 1 index point.
 * - `gex` (gamma exposure): `gammaOi x spot^2 x 0.01`. Rupees of delta-notional that move per 1% move in the index.
 * - `decay`: `-theta x OI`. Rupees of premium the OI loses per calendar day if held long (positive = buyers pay). A deep
 *   in-the-money contract can have positive theta, so this can be negative for it.
 *
 * Gamma and theta are unrounded (`blackScholesGreeksExact`), so they differ from the Greeks tab's six-decimal figures in
 * the last place (and by a few percent for far out-of-the-money gamma, where the tab's value is the coarse one). Greeks are with respect to the forward-consistent pricing spot (`forward x e^(-rT)`), the codebase's convention, which is
 * within about 0.2% of the index for a one-week expiry. The totals cover the strikes in the chain's stored window only
 * (it slides with ATM): open interest on strikes outside it is not included, so each total is a lower bound.
 */
import { RISK_FREE_RATE, blackScholesGreeksExact, effectiveSpotForForward } from "@ai-quant-lab/pricing";

export interface ExposureLegInput {
  /** Underlying units, as Fyers reports it (not lots). Null when not reported. */
  openInterest: number | null;
  /** Solved from the mid; null when the IV could not be measured. */
  impliedVolatility: number | null;
  /** Calendar days to expiry as the chain carries them. */
  daysToExpiry: number | null;
  /** What Fyers reported for gamma, shared by call and put at a strike; 4 decimals, so coarse. */
  vendorGamma?: number | null;
}

export interface ExposureStrikeInput {
  strikePrice: number;
  call: ExposureLegInput | null;
  put: ExposureLegInput | null;
}

export type ExposureConvention = "calls-long" | "puts-long";

export const CONVENTION_TEXT: Record<ExposureConvention, string> = {
  "calls-long": "Assumed: calls held long, puts held short, so net = call exposure - put exposure.",
  "puts-long": "Assumed: puts held long, calls held short, so net = put exposure - call exposure.",
};

/** The sweep covers this far either side of spot, in steps of `SWEEP_STEP_PERCENT`. */
export const SWEEP_RANGE_PERCENT = 4;
export const SWEEP_STEP_PERCENT = 0.2;

export type ExclusionReason = "noOpenInterest" | "noImpliedVolatility" | "noExpiry";

export interface LegExposure {
  gamma: number;
  theta: number;
  gammaOi: number;
  /** Rupees of delta-notional per 1% move in the index, at the spot it was priced at. */
  gex: number;
  /** Rupees of premium lost per calendar day by this leg's OI if held long. */
  decay: number;
}

/**
 * One leg's exposure at a given index spot and forward, or the reason it cannot be computed. Zero OI is a real zero, not an
 * exclusion; a missing OI, an unsolved IV or a missing or expired time to expiry is.
 */
export function legExposure(input: {
  strikePrice: number;
  optionType: "CE" | "PE";
  leg: ExposureLegInput;
  spot: number;
  forward: number;
}): LegExposure | { excluded: ExclusionReason } {
  const { leg, spot, forward, strikePrice, optionType } = input;
  if (leg.openInterest === null || !Number.isFinite(leg.openInterest) || leg.openInterest < 0) return { excluded: "noOpenInterest" };
  if (leg.impliedVolatility === null || !(leg.impliedVolatility > 0)) return { excluded: "noImpliedVolatility" };
  if (leg.daysToExpiry === null || !(leg.daysToExpiry > 0)) return { excluded: "noExpiry" };

  const timeToExpiryYears = leg.daysToExpiry / 365;
  const pricingSpot = effectiveSpotForForward(forward, RISK_FREE_RATE, timeToExpiryYears);
  // Unrounded: `priceEuropeanOption` rounds gamma to six decimals, a 5% error on the out-of-the-money strikes where OI sits.
  const greeks = blackScholesGreeksExact({
    spot: pricingSpot,
    strike: strikePrice,
    timeToExpiryYears,
    riskFreeRate: RISK_FREE_RATE,
    volatility: leg.impliedVolatility,
    optionType,
  });
  const gammaOi = greeks.gamma * leg.openInterest;
  return {
    gamma: greeks.gamma,
    theta: greeks.theta,
    gammaOi,
    gex: gammaOi * spot * spot * 0.01,
    decay: -greeks.theta * leg.openInterest,
  };
}

export interface ExposurePoint {
  strike: number;
  callGammaOi: number | null;
  putGammaOi: number | null;
  callGex: number | null;
  putGex: number | null;
  /** Net gamma exposure under the chosen convention. Null unless both sides are computable. */
  netGex: number | null;
  callDecay: number | null;
  putDecay: number | null;
}

export interface ExposureTotals {
  callGammaOi: number;
  putGammaOi: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callDecay: number;
  putDecay: number;
  strikesInChain: number;
  lowestStrike: number | null;
  highestStrike: number | null;
  /** Legs left out of the totals, by reason: a leg is only ever left out, never counted as zero. */
  excluded: { call: Record<ExclusionReason, number>; put: Record<ExclusionReason, number> };
}

export interface SweepPoint {
  /** Hypothetical index spot and its distance from the real one. */
  spot: number;
  percent: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

export interface GammaFlip {
  /** The spot where the net exposure changes sign, linearly interpolated between sweep steps. */
  spot: number;
  /** Distance from the real spot, in percent. */
  percent: number;
  /** Sign of the net exposure just above the flip. */
  above: "positive" | "negative";
}

export interface VendorGammaComparison {
  /** Strikes where both the model and Fyers have a gamma and OI on the call. */
  strikesCompared: number;
  modelGammaOi: number;
  vendorGammaOi: number;
  /** Vendor over model. Fyers rounds gamma to four decimals, so a single strike is coarse; a total averages it out. */
  ratio: number | null;
}

export interface ExposureResult {
  spot: number;
  forward: number;
  forwardFromChain: boolean;
  convention: ExposureConvention;
  points: ExposurePoint[];
  totals: ExposureTotals;
  sweep: SweepPoint[];
  /** The sign changes of the net exposure inside the sweep, nearest the real spot first. Empty when it never changes sign. */
  flips: GammaFlip[];
  vendor: VendorGammaComparison | null;
}

function emptyExclusions(): Record<ExclusionReason, number> {
  return { noOpenInterest: 0, noImpliedVolatility: 0, noExpiry: 0 };
}

function sign(convention: ExposureConvention): number {
  return convention === "calls-long" ? 1 : -1;
}

/** Totals of the call and put exposure over every strike, at one spot (forward carried in proportion). */
function netAtSpot(
  strikes: readonly ExposureStrikeInput[],
  spot: number,
  forward: number,
  convention: ExposureConvention,
): { callGex: number; putGex: number; netGex: number } {
  let callGex = 0;
  let putGex = 0;
  for (const row of strikes) {
    if (row.call) {
      const r = legExposure({ strikePrice: row.strikePrice, optionType: "CE", leg: row.call, spot, forward });
      if (!("excluded" in r)) callGex += r.gex;
    }
    if (row.put) {
      const r = legExposure({ strikePrice: row.strikePrice, optionType: "PE", leg: row.put, spot, forward });
      if (!("excluded" in r)) putGex += r.gex;
    }
  }
  return { callGex, putGex, netGex: sign(convention) * (callGex - putGex) };
}

/** Net gamma exposure at a hypothetical spot, with the forward moved in proportion. Exported so the flip can be checked. */
export function netGexAtSpot(
  strikes: readonly ExposureStrikeInput[],
  base: { spot: number; forward: number },
  hypotheticalSpot: number,
  convention: ExposureConvention,
): number {
  return netAtSpot(strikes, hypotheticalSpot, base.forward * (hypotheticalSpot / base.spot), convention).netGex;
}

export interface BuildExposureOptions {
  spot: number;
  /** The expiry's parity-implied forward. When absent, spot stands in for it, and `forwardFromChain` says so. */
  forward?: number | null;
  atmStrike: number | null;
  /** Half-width in strike count around ATM for the per-strike points; the totals always use every strike. */
  window?: number | null;
  convention?: ExposureConvention;
}

export function buildExposure(strikes: readonly ExposureStrikeInput[], options: BuildExposureOptions): ExposureResult {
  const { spot, atmStrike } = options;
  const convention = options.convention ?? "calls-long";
  const forwardFromChain = options.forward !== null && options.forward !== undefined && options.forward > 0;
  const forward = forwardFromChain ? options.forward! : spot;
  const ordered = [...strikes].sort((a, b) => a.strikePrice - b.strikePrice);
  const s = sign(convention);

  const excluded = { call: emptyExclusions(), put: emptyExclusions() };
  const totals = { callGammaOi: 0, putGammaOi: 0, callGex: 0, putGex: 0, callDecay: 0, putDecay: 0 };
  let vendorModel = 0;
  let vendorVendor = 0;
  let vendorStrikes = 0;

  const all: ExposurePoint[] = ordered.map((row) => {
    const call = row.call ? legExposure({ strikePrice: row.strikePrice, optionType: "CE", leg: row.call, spot, forward }) : null;
    const put = row.put ? legExposure({ strikePrice: row.strikePrice, optionType: "PE", leg: row.put, spot, forward }) : null;
    const callOk = call && !("excluded" in call) ? call : null;
    const putOk = put && !("excluded" in put) ? put : null;

    if (call && "excluded" in call) excluded.call[call.excluded] += 1;
    if (put && "excluded" in put) excluded.put[put.excluded] += 1;
    if (callOk) { totals.callGammaOi += callOk.gammaOi; totals.callGex += callOk.gex; totals.callDecay += callOk.decay; }
    if (putOk) { totals.putGammaOi += putOk.gammaOi; totals.putGex += putOk.gex; totals.putDecay += putOk.decay; }

    const vendorGamma = row.call?.vendorGamma ?? null;
    if (callOk && vendorGamma !== null && vendorGamma > 0 && row.call?.openInterest) {
      vendorStrikes += 1;
      vendorModel += callOk.gamma * row.call.openInterest;
      vendorVendor += vendorGamma * row.call.openInterest;
    }

    return {
      strike: row.strikePrice,
      callGammaOi: callOk?.gammaOi ?? null,
      putGammaOi: putOk?.gammaOi ?? null,
      callGex: callOk?.gex ?? null,
      putGex: putOk?.gex ?? null,
      netGex: callOk && putOk ? s * (callOk.gex - putOk.gex) : null,
      callDecay: callOk?.decay ?? null,
      putDecay: putOk?.decay ?? null,
    };
  });

  // The per-strike points are the window around ATM; the totals above already used every strike.
  const window = options.window ?? null;
  let points = all;
  if (window !== null && window >= 0 && all.length > 0) {
    const centre = atmStrike !== null && all.some((p) => p.strike === atmStrike)
      ? all.findIndex((p) => p.strike === atmStrike)
      : Math.floor(all.length / 2);
    points = all.slice(Math.max(0, centre - window), Math.min(all.length, centre + window + 1));
  }

  const sweep: SweepPoint[] = [];
  const steps = Math.round(SWEEP_RANGE_PERCENT / SWEEP_STEP_PERCENT);
  for (let i = -steps; i <= steps; i += 1) {
    const percent = Math.round(i * SWEEP_STEP_PERCENT * 1e6) / 1e6;
    const hypothetical = spot * (1 + percent / 100);
    const at = netAtSpot(ordered, hypothetical, forward * (hypothetical / spot), convention);
    sweep.push({ spot: hypothetical, percent, ...at });
  }

  const flips: GammaFlip[] = [];
  for (let i = 1; i < sweep.length; i += 1) {
    const a = sweep[i - 1]!;
    const b = sweep[i]!;
    if ((a.netGex < 0 && b.netGex > 0) || (a.netGex > 0 && b.netGex < 0)) {
      const t = a.netGex / (a.netGex - b.netGex);
      const flipSpot = a.spot + t * (b.spot - a.spot);
      flips.push({ spot: flipSpot, percent: (flipSpot / spot - 1) * 100, above: b.netGex > 0 ? "positive" : "negative" });
    }
  }
  flips.sort((x, y) => Math.abs(x.percent) - Math.abs(y.percent));

  const strikePrices = ordered.map((row) => row.strikePrice);
  return {
    spot,
    forward,
    forwardFromChain,
    convention,
    points,
    totals: {
      ...totals,
      netGex: s * (totals.callGex - totals.putGex),
      strikesInChain: ordered.length,
      lowestStrike: strikePrices.length > 0 ? strikePrices[0]! : null,
      highestStrike: strikePrices.length > 0 ? strikePrices[strikePrices.length - 1]! : null,
      excluded,
    },
    sweep,
    flips,
    vendor: vendorStrikes > 0
      ? { strikesCompared: vendorStrikes, modelGammaOi: vendorModel, vendorGammaOi: vendorVendor, ratio: vendorModel > 0 ? vendorVendor / vendorModel : null }
      : null,
  };
}

/** Rupees as lakh or crore, for axes and totals. Sign kept. */
export function formatRupees(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Gamma-weighted OI in delta-units per index point, compact. */
export function formatDeltaUnits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)} k`;
  return `${sign}${abs.toFixed(1)}`;
}
