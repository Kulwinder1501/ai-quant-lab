import { describe, expect, it } from "vitest";
import {
  breakdownFees,
  calculateEntryFees,
  calculateExercisedExpiryFees,
  calculateExitFees,
  calculateTotalFees,
  OPTIONS_BROKERAGE_PER_ORDER,
} from "./brokerage-calculator.js";

describe("brokerage-calculator (Zerodha NSE options buyer)", () => {
  it("charges flat ₹20 brokerage on both buy and sell legs", () => {
    const buy = calculateEntryFees(100, 75);
    const sell = calculateExitFees(120, 75);
    expect(buy.brokerage).toBe(OPTIONS_BROKERAGE_PER_ORDER);
    expect(sell.brokerage).toBe(OPTIONS_BROKERAGE_PER_ORDER);
  });

  it("applies STT only on the sell side and stamp duty only on the buy side", () => {
    const buy = breakdownFees(100, 75, "BUY");
    const sell = breakdownFees(100, 75, "SELL");
    expect(buy.stt).toBe(0);
    expect(buy.stampDuty).toBeGreaterThan(0);
    expect(sell.stt).toBeGreaterThan(0);
    expect(sell.stampDuty).toBe(0);
  });

  it("matches a known single-lot NIFTY premium round-trip within paise rounding", () => {
    // Premium ₹150 × 75 units = ₹11,250 turnover.
    const roundTrip = calculateTotalFees(150, 150, 75);
    expect(roundTrip.entry.turnover).toBe(11250);
    expect(roundTrip.exit.turnover).toBe(11250);
    // Buy: brokerage 20 + exchange ≈ 3.94 + SEBI ≈ 0.01 + GST ≈ 4.31 + stamp ≈ 0.34
    expect(roundTrip.entry.total).toBeGreaterThan(20);
    expect(roundTrip.entry.stt).toBe(0);
    // Sell adds STT at 0.1% of premium turnover.
    expect(roundTrip.exit.stt).toBe(11.25);
    expect(roundTrip.total).toBe(roundTrip.entry.total + roundTrip.exit.total);
    // Every itemised charge on the buy leg, so a rate change cannot pass unnoticed.
    expect(roundTrip.entry.exchangeTxnCharges).toBe(3.94);
    expect(roundTrip.entry.sebiCharges).toBe(0.01);
    expect(roundTrip.entry.stampDuty).toBe(0.34);
    expect(roundTrip.entry.gst).toBe(4.31);
  });

  it("charges STT at the option-sale rate, not the exercise rate", () => {
    // 0.1% of premium on sale. 0.125% is the rate for an *exercised* option and applies
    // to intrinsic value, not premium turnover -- using it here overstated every exit
    // by 25%.
    const sell = breakdownFees(150, 75, "SELL");

    expect(sell.turnover).toBe(11_250);
    expect(sell.stt).toBe(11.25);
    expect(sell.stt).not.toBe(14.06);
  });

  it("charges nothing to let a long option expire worthless", () => {
    // The NSE option tick is 0.05, so a fill at 0 cannot happen in the market: this is
    // an expiry, not a sale, and no order means no brokerage. This used to bill 23.60.
    const fees = calculateExitFees(0, 75);

    expect(fees.turnover).toBe(0);
    expect(fees.brokerage).toBe(0);
    expect(fees.gst).toBe(0);
    expect(fees.total).toBe(0);
  });

  it("charges exercise STT on intrinsic value, with no brokerage", () => {
    // 200 points intrinsic on 75 units is 15,000 of settlement value; exercise STT is
    // 0.125% of that. This is the event the 0.125% rate belongs to.
    const fees = calculateExercisedExpiryFees(200, 75);

    expect(fees.turnover).toBe(15_000);
    expect(fees.stt).toBe(18.75);
    expect(fees.brokerage).toBe(0);
    expect(fees.gst).toBe(0);
    expect(fees.total).toBe(18.75);
  });

  it("keeps the exercise rate distinct from the sale rate", () => {
    // Same rupee value, different taxable events: 0.125% on exercise, 0.1% on sale.
    const exercised = calculateExercisedExpiryFees(150, 75).stt;
    const sold = breakdownFees(150, 75, "SELL").stt;

    expect(exercised).toBe(14.06);
    expect(sold).toBe(11.25);
  });

  it("rejects a negative intrinsic value rather than crediting STT", () => {
    expect(() => calculateExercisedExpiryFees(-1, 75)).toThrow(/Intrinsic value/);
    expect(() => calculateExercisedExpiryFees(100, 0)).toThrow(/Quantity/);
  });

  it("rejects non-positive quantity", () => {
    expect(() => calculateEntryFees(10, 0)).toThrow(/Quantity/);
    expect(() => calculateEntryFees(10, 1.5)).toThrow(/Quantity/);
  });
});
