/**
 * Short, human wording for why an implied volatility could not be solved.
 *
 * The reasons come from `impliedVolatilityFromPremium` (packages/pricing) and mean different things
 * to a trader: an expired contract, an unquoted one and a stale price below intrinsic each imply a
 * different action, so a blank would hide the distinction. Shared by the chain table and the charts
 * so the same refusal reads the same everywhere.
 */
export function ivRefusalLabel(reason: string | null): string {
  switch (reason) {
    case "EXPIRED_OR_ZERO_TIME": return "expired";
    case "NO_TWO_SIDED_QUOTE": return "no quote";
    case "BELOW_INTRINSIC": return "sub-intr.";
    case "ABOVE_UPPER_BOUND": return "over cap";
    case "EXTRINSIC_BELOW_PRICE_RESOLUTION": return "no extr.";
    case "NO_UNDERLYING": return "no spot";
    case "NO_PREMIUM": return "no premium";
    default: return "—";
  }
}
