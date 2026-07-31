/**
 * Indian F&O Brokerage Calculator — Zerodha / NSE fee structure.
 */

export const OPTIONS_BROKERAGE_PER_ORDER = 20;

/**
 * STT on the *sale of an option*: 0.1% of premium, charged on the sell leg only.
 *
 * This was 0.00125 (0.125%), which overstated every exit by 25%. 0.125% is a real STT
 * rate, but it is the rate for an option that is **exercised**, and it applies to
 * intrinsic value rather than to premium turnover. Selling an option in the market and
 * exercising one are different taxable events with different bases, and only the former
 * is modelled here -- an exercised expiry would need intrinsic value, which this
 * function is not given.
 */
const OPTION_SALE_STT_RATE = 0.001;

/** NSE options exchange transaction charge: 0.03503% of premium turnover. */
const EXCHANGE_TXN_RATE = 0.0003503;
const GST_RATE = 0.18; // 18%
const SEBI_PER_CRORE = 10;
const ONE_CRORE = 1e7;
const STAMP_DUTY_RATE = 0.00003; // 0.003%, buy side only

function roundInr(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface FeeBreakdown {
  turnover: number;
  brokerage: number;
  stt: number;
  exchangeTxnCharges: number;
  sebiCharges: number;
  gst: number;
  stampDuty: number;
  total: number;
}

export interface TradeFeeBreakdown {
  entry: FeeBreakdown;
  exit: FeeBreakdown;
  total: number;
}

export function breakdownFees(premium: number, quantity: number, side: "BUY" | "SELL"): FeeBreakdown {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer.");
  }

  const turnover = premium * quantity;
  const brokerage = OPTIONS_BROKERAGE_PER_ORDER;
  
  const stt = side === "SELL" ? roundInr(turnover * OPTION_SALE_STT_RATE) : 0;
  // Uses the declared rate. A hardcoded 0.00035 was used here while
  // EXCHANGE_TXN_RATE sat unused, so the documented rate and the applied one differed.
  const exchangeTxnCharges = roundInr(turnover * EXCHANGE_TXN_RATE);
  const sebiCharges = roundInr((turnover / ONE_CRORE) * SEBI_PER_CRORE);
  const gst = roundInr((brokerage + exchangeTxnCharges + sebiCharges) * GST_RATE);
  const stampDuty = side === "BUY" ? roundInr(turnover * STAMP_DUTY_RATE) : 0;
  
  const total = roundInr(brokerage + stt + exchangeTxnCharges + sebiCharges + gst + stampDuty);
  
  return {
    turnover,
    brokerage,
    stt,
    exchangeTxnCharges,
    sebiCharges,
    gst,
    stampDuty,
    total,
  };
}

export function calculateEntryFees(premium: number, quantity: number): FeeBreakdown {
  return breakdownFees(premium, quantity, "BUY");
}

export function calculateExitFees(premium: number, quantity: number): FeeBreakdown {
  return breakdownFees(premium, quantity, "SELL");
}

export function calculateTotalFees(entryPremium: number, exitPremium: number, quantity: number): TradeFeeBreakdown {
  const entry = calculateEntryFees(entryPremium, quantity);
  const exit = calculateExitFees(exitPremium, quantity);
  return {
    entry,
    exit,
    total: roundInr(entry.total + exit.total),
  };
}
