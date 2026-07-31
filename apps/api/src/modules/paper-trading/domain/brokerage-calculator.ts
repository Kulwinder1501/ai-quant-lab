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

  // Zero turnover means no order was placed, so nothing is chargeable. The NSE option
  // tick is 0.05, so a fill at 0 cannot occur in the market: this is a long option left
  // to expire worthless, and letting it expire costs nothing. Charging the flat 20 plus
  // GST here billed 23.60 for a transaction that never happened. An option that expires
  // *in* the money is a different event -- see `calculateExercisedExpiryFees`.
  if (turnover === 0) {
    return {
      turnover: 0,
      brokerage: 0,
      stt: 0,
      exchangeTxnCharges: 0,
      sebiCharges: 0,
      gst: 0,
      stampDuty: 0,
      total: 0,
    };
  }

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

/**
 * STT on an option that expires **in the money and is exercised**: 0.125% of intrinsic
 * value, with no brokerage.
 *
 * This is the event the 0.125% rate actually belongs to, and it is why that rate was
 * plausible enough to end up misapplied to ordinary sales. It is a separate function
 * because it needs a different input: intrinsic value at settlement, not premium
 * turnover. Exchange, SEBI, GST, and stamp charges do not arise -- no order is placed.
 */
export const EXERCISED_OPTION_STT_RATE = 0.00125;

export function calculateExercisedExpiryFees(intrinsicValue: number, quantity: number): FeeBreakdown {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer.");
  }
  if (!Number.isFinite(intrinsicValue) || intrinsicValue < 0) {
    throw new Error("Intrinsic value must be zero or positive.");
  }

  const settlementValue = intrinsicValue * quantity;
  const stt = roundInr(settlementValue * EXERCISED_OPTION_STT_RATE);
  return {
    turnover: settlementValue,
    brokerage: 0,
    stt,
    exchangeTxnCharges: 0,
    sebiCharges: 0,
    gst: 0,
    stampDuty: 0,
    total: stt,
  };
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
