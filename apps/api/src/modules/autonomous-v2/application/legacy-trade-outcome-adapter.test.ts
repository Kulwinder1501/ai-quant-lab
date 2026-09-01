import { describe, expect, it } from "vitest";
import {
  layeredOutcomeFromClosedTrade,
  type LegacyClosedTrade,
} from "./legacy-trade-outcome-adapter.js";
import { attributeShortfall } from "../domain/outcome-layers.js";

function trade(overrides: Partial<LegacyClosedTrade> = {}): LegacyClosedTrade {
  return {
    tradeId: "trade-1",
    contractSymbol: "NSE:BANKNIFTY26SEP57500CE",
    side: "LONG",
    quantity: 15,
    entryPrice: 200,
    exitPrice: 260,
    realisedPnl: 870,
    fees: 30,
    underlyingEntryPrice: 57_400,
    hasPartialExits: false,
    ...overrides,
  };
}

describe("adapting a legacy closed trade", () => {
  it("recomputes theoretical P&L from the recorded prices and derives erosion", () => {
    const { outcome } = layeredOutcomeFromClosedTrade(trade());

    expect(outcome.execution.theoreticalPnl).toBe(900);
    expect(outcome.execution.erosion).toBe(30);
    expect(outcome.execution.realisedPnl).toBe(870);
  });

  it("reports a residual of zero when the booked P&L is explained by fees", () => {
    // The expected steady state: prices imply 900, book says 870, fees are 30.
    const { unexplainedResidual } = layeredOutcomeFromClosedTrade(trade());

    expect(unexplainedResidual).toBe(0);
  });

  it("surfaces a residual when the booked P&L disagrees with the prices beyond fees", () => {
    /*
     * The detector. This is the mark-pricing defect's shape: prices that imply one figure and a booked
     * P&L that says something else. It is reported rather than thrown, because the adapter's job is to
     * measure, and a single odd trade is a finding rather than a reason to fail a batch.
     */
    const { unexplainedResidual } = layeredOutcomeFromClosedTrade(trade({ realisedPnl: -651 }));

    expect(unexplainedResidual).toBe(1_521);
  });

  it("leaves the underlying layer absent and therefore declines to attribute", () => {
    /*
     * `paper_trades` records `underlying_entry_price` and no underlying exit, and the holding-period
     * candles belong to the option contract. Deriving an underlying exit from candles was rejected: it
     * would be a reconstruction standing beside observed fills, and `attributeShortfall` reads
     * `resolution` to decide whether the *thesis* was wrong.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade({ realisedPnl: -800, exitPrice: 150 }));

    expect(outcome.underlying).toBeNull();
    expect(attributeShortfall(outcome)).toBeNull();
  });

  it("marks the price source as the observed book, so a regression to marks throws", () => {
    /*
     * The mark-pricing defect was fixed on 2026-08-05 and both legs now price from the observed book.
     * `reconcileOutcome` refuses MODEL_MARK on a closed outcome, so if that regresses this adapter
     * fails loudly instead of reporting a modelled number as a fill.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade());

    expect(outcome.instrument.priceSource).toBe("OBSERVED_BOOK");
    expect(outcome.closed).toBe(true);
  });

  it("computes a SHORT from the other side", () => {
    const { outcome, unexplainedResidual } = layeredOutcomeFromClosedTrade(trade({
      side: "SHORT", entryPrice: 260, exitPrice: 200, realisedPnl: 870,
    }));

    expect(outcome.execution.theoreticalPnl).toBe(900);
    expect(unexplainedResidual).toBe(0);
  });

  it("still computes a residual for a partially exited trade, and records that it was one", () => {
    /*
     * Corrected by the data. The first version reported a partially exited trade as NOT_COMPARABLE,
     * reasoning that `(exit - entry) x quantity` cannot hold when `exitPrice` is one tranche's price.
     * Measured against the 322 real closed trades, the identity holds for every one of the 321 that
     * exited in tranches -- so the exclusion would have discarded 99.7% of the population and the
     * detector would have reported nothing at all.
     *
     * The flag travels instead, because a large residual on a partially exited trade has a benign
     * explanation available that a full-exit trade does not.
     */
    const adapted = layeredOutcomeFromClosedTrade(trade({ hasPartialExits: true }));

    expect(adapted.hasPartialExits).toBe(true);
    expect(adapted.unexplainedResidual).toBe(0);
  });

  it("reproduces the one real anomaly: P&L booked gross where fees were expected", () => {
    /*
     * Trade 951a0ecb on 2026-08-31, the only closed trade of 322 whose `realized_pnl` is gross rather
     * than net of fees -- and the only one with no partial exits. Its residual is exactly its fees.
     *
     * Pinned as a regression: it is the shape the detector is for, and it was found by running the
     * adapter over real data rather than by reasoning about it.
     */
    const adapted = layeredOutcomeFromClosedTrade(trade({
      quantity: 75, entryPrice: 212.95, exitPrice: 203.17, fees: 30.7,
      realisedPnl: -733.5, hasPartialExits: false,
    }));

    expect(adapted.outcome.execution.theoreticalPnl).toBeCloseTo(-733.5, 6);
    expect(adapted.unexplainedResidual).toBeCloseTo(-30.7, 6);
  });

  it("keeps unrecorded slippage null rather than zero", () => {
    // Zero would claim a measurement. Paper trades do not record per-leg slippage.
    const { outcome } = layeredOutcomeFromClosedTrade(trade());

    expect(outcome.execution.entrySlippage).toBeNull();
    expect(outcome.execution.exitSlippage).toBeNull();
  });

  it("treats missing fees as unknown, not as zero fees", () => {
    // The residual then absorbs the fees, which is why `fees` null is worth seeing in a report rather
    // than silently folded in.
    const { outcome, unexplainedResidual } = layeredOutcomeFromClosedTrade(trade({ fees: null }));

    expect(outcome.execution.fees).toBeNull();
    expect(unexplainedResidual).toBe(30);
  });
});
