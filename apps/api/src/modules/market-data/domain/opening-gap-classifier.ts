/**
 * Deterministic opening-gap classifier for NIFTY50 and BANKNIFTY.
 *
 * The original idea for this was to threshold GIFT Nifty's overnight change, but GIFT Nifty has
 * no free, live, machine-readable feed anywhere this codebase can reach -- `institutional-flow-
 * summary.ts`'s `GiftNiftyUnavailableReason` docstring already records seven Yahoo tickers tried
 * and rejected (`GIFTNIFTY`, `NIFTY_F1`, `^NSEIX`, `GIFT=F`, `SGXNIFTY`, `IN50=F`, `NIFTYF.NS`),
 * and NSE's own public site was independently checked for this feature (2026-10-10) and does not
 * publish it either -- GIFT Nifty trades on NSE IX, a separate IFSC exchange.
 *
 * This classifier instead thresholds the S&P 500's own prior-session percentage change, used as a
 * free proxy driver: published research and desk practice both treat the prior US close as the
 * dominant single overnight input to India's open, with Asian markets acting as a confirming
 * factor rather than the primary driver.
 *
 * The thresholds below are carried over unchanged from the original GIFT-Nifty-denominated plan
 * and applied directly to the S&P 500's raw percentage change, not to a GIFT-Nifty-equivalent
 * figure -- GIFT Nifty itself typically moves at roughly 0.6-0.8x of a same-day S&P 500 move per
 * external sources, which is not yet verified against this system's own data. They are a starting
 * point to be recalibrated once enough settled predictions exist, not a validated rule.
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
