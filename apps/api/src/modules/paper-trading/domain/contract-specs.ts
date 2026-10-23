/**
 * Plausibility checks for F&O contract specifications.
 *
 * Lot sizes live in `instruments` so a revision is a data change, which is right --
 * but it also means a stale value sits there silently producing wrong position sizes.
 * BANKNIFTY was configured at 15 while the index traded near 57,000, implying a
 * ₹8.6 lakh contract against a ₹15 lakh regulatory floor, and nothing noticed.
 *
 * SEBI's minimum contract value for index derivatives is ₹15 lakh, and exchanges size
 * lots to land in roughly ₹15-20 lakh. A configured lot size whose implied notional
 * falls outside that band is not necessarily illegal, but it is almost always stale, so
 * it is worth surfacing rather than trusting.
 */

export const MINIMUM_CONTRACT_VALUE_INR = 1_500_000;
/**
 * Lower bound for the *staleness* check, deliberately under the regulatory minimum.
 *
 * ₹15 lakh is the value exchanges size a lot to when they set or revise it. Between revisions the
 * contract's value follows the index, so a correct lot sits below ₹15 lakh whenever the index has
 * fallen since the last review: NIFTY's exchange-listed lot of 65 is about ₹14.6 lakh at 22,500.
 * Treating the revision-time minimum as a continuous floor graded that correct lot "stale", and
 * `selectInstrument` rejects any non-PLAUSIBLE verdict, so correcting NIFTY's lot from 75 would have
 * stopped every NIFTY entry. The upper bound already tolerated upward drift for the same reason; this
 * is the symmetric allowance, 20% under the minimum. It still catches a lot a whole revision behind:
 * BANKNIFTY's stale 15 was ₹8.6 lakh, 57% of the minimum.
 */
export const STALE_LOT_FLOOR_INR = 1_200_000;
/**
 * Upper bound for the plausibility check only. Exchanges revise lots as an index
 * drifts, so a contract can legitimately exceed ₹20 lakh between revisions; this is
 * generous enough not to cry wolf while still catching a lot size that is a whole
 * revision behind.
 */
export const MAXIMUM_PLAUSIBLE_CONTRACT_VALUE_INR = 2_600_000;

export type ContractSizeVerdict = "PLAUSIBLE" | "BELOW_REGULATORY_MINIMUM" | "IMPLAUSIBLY_LARGE";

export interface ContractSizeAssessment {
  verdict: ContractSizeVerdict;
  notional: number;
  /** Lot size that would place the contract at the regulatory floor. */
  minimumViableLotSize: number;
  explanation: string;
}

export function contractNotional(lotSize: number, underlyingPrice: number): number {
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    throw new Error("Lot size must be a positive integer.");
  }
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    throw new Error("Underlying price must be positive.");
  }
  return lotSize * underlyingPrice;
}

/** Judges a configured lot size against the value band the exchange sizes lots to. */
export function assessContractSize(lotSize: number, underlyingPrice: number): ContractSizeAssessment {
  const notional = contractNotional(lotSize, underlyingPrice);
  const minimumViableLotSize = Math.ceil(MINIMUM_CONTRACT_VALUE_INR / underlyingPrice);

  if (notional < STALE_LOT_FLOOR_INR) {
    return {
      verdict: "BELOW_REGULATORY_MINIMUM",
      notional,
      minimumViableLotSize,
      explanation:
        `Lot size ${lotSize} at ${underlyingPrice.toFixed(2)} implies a ${Math.round(notional).toLocaleString("en-IN")} `
        + `contract, below the ${STALE_LOT_FLOOR_INR.toLocaleString("en-IN")} staleness floor (the `
        + `${MINIMUM_CONTRACT_VALUE_INR.toLocaleString("en-IN")} minimum less 20% for index drift between revisions). `
        + `At least ${minimumViableLotSize} units reach the minimum, so this lot size is very likely stale.`,
    };
  }
  if (notional > MAXIMUM_PLAUSIBLE_CONTRACT_VALUE_INR) {
    return {
      verdict: "IMPLAUSIBLY_LARGE",
      notional,
      minimumViableLotSize,
      explanation:
        `Lot size ${lotSize} at ${underlyingPrice.toFixed(2)} implies a ${Math.round(notional).toLocaleString("en-IN")} `
        + "contract, larger than exchanges normally size lots to. Verify against the current contract note.",
    };
  }
  const drifted = notional < MINIMUM_CONTRACT_VALUE_INR;
  return {
    verdict: "PLAUSIBLE",
    notional,
    minimumViableLotSize,
    explanation: drifted
      ? `Lot size ${lotSize} implies a ${Math.round(notional).toLocaleString("en-IN")} contract: under the `
        + `${MINIMUM_CONTRACT_VALUE_INR.toLocaleString("en-IN")} revision-time minimum, but within the allowance `
        + "for the index having fallen since the lot was last revised."
      : `Lot size ${lotSize} implies a ${Math.round(notional).toLocaleString("en-IN")} contract, inside the expected band.`,
  };
}
