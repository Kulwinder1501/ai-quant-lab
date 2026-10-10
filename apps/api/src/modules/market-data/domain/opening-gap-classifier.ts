/**
 * Deterministic opening-gap classifier for NIFTY50 and BANKNIFTY.
 *
 * Thresholds GIFT Nifty's own overnight percentage change (`driverSymbol: "GIFT_NIFTY"` in
 * `predict-opening-gap.ts`, read live from NSE IX's own public homepage API via
 * `NseIxClient.getGiftNiftyFuturesQuote` -- see `nse-ix-client.ts`).
 *
 * This briefly ran on the S&P 500's own change as a free proxy, because GIFT Nifty appeared to
 * have no free, live, machine-readable feed anywhere this codebase could reach:
 * `institutional-flow-summary.ts`'s `GiftNiftyUnavailableReason` docstring records seven Yahoo
 * tickers tried and rejected, and NSE's main site was checked and does not publish it either.
 * NSE IX -- the actual IFSC exchange GIFT Nifty trades on -- was checked afterwards (2026-10-10)
 * and does carry a real, free, unauthenticated feed; see `nse-ix-client.ts` for how it was found
 * and verified. The S&P 500 is now a supplementary cue alongside Nikkei/Hang Seng instead of the
 * driver.
 *
 * The thresholds below are the original plan's (NIFTY50 +/-0.25%, BANKNIFTY +/-0.35%), applied
 * to GIFT Nifty's own change as intended -- not yet verified against this system's own settled
 * data, so still a starting point to be recalibrated, not a validated rule.
 */

export type GapExpectation = "GAP_UP" | "GAP_DOWN" | "FLAT";

export const OPENING_GAP_CLASSIFIER_INSTRUMENTS = ["NIFTY50", "BANKNIFTY"] as const;

export type OpeningGapClassifierInstrument = (typeof OPENING_GAP_CLASSIFIER_INSTRUMENTS)[number];

export const OPENING_GAP_THRESHOLD_PCT: Record<OpeningGapClassifierInstrument, number> = {
  NIFTY50: 0.25,
  BANKNIFTY: 0.35,
};

export function isOpeningGapClassifierInstrument(symbol: string): symbol is OpeningGapClassifierInstrument {
  return (OPENING_GAP_CLASSIFIER_INSTRUMENTS as readonly string[]).includes(symbol);
}

/**
 * Buckets a percentage change against a symmetric threshold. Inclusive at the boundary (a change
 * exactly at the threshold counts as the gap, not as FLAT), matching the opening-gap target table
 * this classifier implements ("Return >= +0.25%").
 */
export function classifyOpeningGap(changePct: number, thresholdPct: number): GapExpectation {
  if (!Number.isFinite(changePct)) {
    throw new Error(`changePct must be a finite number; got ${changePct}.`);
  }
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    throw new Error(`thresholdPct must be a positive finite number; got ${thresholdPct}.`);
  }
  if (changePct >= thresholdPct) return "GAP_UP";
  if (changePct <= -thresholdPct) return "GAP_DOWN";
  return "FLAT";
}
