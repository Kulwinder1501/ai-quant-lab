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
    // Absent by default, so every residual assertion below keeps exercising the pre-089 shape.
    underlyingExitPrice: null,
    underlyingThesis: null,
    // Absent by default, so the existing tests keep exercising ENDPOINT resolution.
    underlyingPath: null,
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

  it("leaves the underlying layer absent when no exit level was observed", () => {
    /*
     * The pre-089 shape, still reached by a close with no tick sample pairing an option quote to an
     * underlying level, and by every trade closed before that migration. Null rather than a level
     * read off the underlying's candles: mid-bar, that close is a future value relative to the exit.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade({ realisedPnl: -800, exitPrice: 150 }));

    expect(outcome.underlying).toBeNull();
    expect(attributeShortfall(outcome)).toBeNull();
  });

  it("treats a missing property the same as an explicit null", () => {
    // These arrive from database rows mapped by hand, so absent and null are one fact.
    const { underlyingExitPrice: _e, underlyingThesis: _t, ...withoutUnderlying } = trade();

    expect(layeredOutcomeFromClosedTrade(withoutUnderlying as never).outcome.underlying).toBeNull();
  });

  it("stays absent when an exit level exists but the thesis levels do not", () => {
    // Both halves are required: with no stop or target there is nothing to resolve the thesis
    // against, and inventing a resolution is what makes an attribution confident and wrong.
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      underlyingExitPrice: 57_200, underlyingThesis: null,
    }));

    expect(outcome.underlying).toBeNull();
  });

  it("builds the layer once 089 supplies an exit level, and then attributes", () => {
    /*
     * The case the three-layer split exists for: the underlying finished through its stop, so the
     * thesis was wrong -- and a single P&L number cannot say that.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      realisedPnl: -800,
      exitPrice: 150,
      underlyingExitPrice: 57_180,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
    }));

    expect(outcome.underlying).not.toBeNull();
    expect(outcome.underlying!.resolution).toBe("INVALIDATED");
    expect(outcome.underlying!.entryReference).toBe(57_400);
    expect(outcome.underlying!.exitReference).toBe(57_180);
    expect(attributeShortfall(outcome)).toBe("UNDERLYING");
  });

  it("reports a reached target, and blames the instrument when the option still lost", () => {
    // Thesis right, expression wrong: a strike or expiry that could not capture a correct call.
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      realisedPnl: -320,
      exitPrice: 180,
      underlyingExitPrice: 57_850,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
    }));

    expect(outcome.underlying!.resolution).toBe("TARGET_REACHED");
    expect(attributeShortfall(outcome)).toBe("INSTRUMENT");
  });

  it("resolves a SHORT thesis from the other side", () => {
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      underlyingExitPrice: 57_100,
      underlyingThesis: { direction: "SHORT", stop: 57_600, target: 57_150 },
    }));

    expect(outcome.underlying!.resolution).toBe("TARGET_REACHED");
  });

  it("says UNRESOLVED_AT_HORIZON between the barriers, and attributes the exit", () => {
    /*
     * Endpoint-only: the underlying may have touched a barrier and given it back, which this cannot
     * see. It is still not "cannot tell" -- the layers agree the position was closed while its thesis
     * was live, which is what EXITED_UNRESOLVED records. The real shape: three of three trades with
     * an observed underlying exit stopped short of their thesis stop while the option closed first.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      realisedPnl: -100,
      exitPrice: 195,
      underlyingExitPrice: 57_500,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
    }));

    expect(outcome.underlying!.resolution).toBe("UNRESOLVED_AT_HORIZON");
    expect(attributeShortfall(outcome)).toBe("EXITED_UNRESOLVED");
  });

  it("reaches INSTRUMENT once the path shows the target was touched", () => {
    /*
     * The verdict that was unreachable until the path was measured. Across 22 real trades with an
     * observed underlying exit, not one finished at its thesis target -- so TARGET_REACHED never
     * occurred and INSTRUMENT, the verdict meaning "the thesis was right and the expression was
     * wrong", could never fire. That was an instrumentation gap, not an absence of instrument
     * failures.
     *
     * Here the underlying touched its target during the hold and gave it back, while the option lost.
     * Endpoint resolution would report UNRESOLVED_AT_HORIZON and attribute nothing.
     */
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      realisedPnl: -320,
      exitPrice: 180,
      underlyingExitPrice: 57_500,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
      underlyingPath: {
        favourableExcursion: 620,
        adverseExcursion: 90,
        excursionTimeframe: "1m",
        firstTouch: "TARGET",
      },
    }));

    expect(outcome.underlying!.resolution).toBe("TARGET_REACHED");
    expect(outcome.underlying!.resolutionBasis).toBe("PATH_TOUCH");
    expect(outcome.underlying!.favourableExcursion).toBe(620);
    expect(outcome.underlying!.excursionTimeframe).toBe("1m");
    expect(attributeShortfall(outcome)).toBe("INSTRUMENT");
  });

  it("blames the underlying when the path shows the stop was hit first", () => {
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      realisedPnl: -800,
      exitPrice: 150,
      underlyingExitPrice: 57_500,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
      underlyingPath: {
        favourableExcursion: 300, adverseExcursion: 250, excursionTimeframe: "1m", firstTouch: "STOP",
      },
    }));

    // Endpoint would say UNRESOLVED here -- 57,500 sits between the barriers -- so the path changes
    // the verdict from "cannot tell" to "the thesis was invalidated".
    expect(outcome.underlying!.resolution).toBe("INVALIDATED");
    expect(attributeShortfall(outcome)).toBe("UNDERLYING");
  });

  it("marks endpoint-derived resolutions as such, so the two are never confused", () => {
    // Without a path the basis is ENDPOINT, and UNRESOLVED then means "not resolved at the end",
    // never "never reached a barrier". A reader has to be able to tell which claim they hold.
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      underlyingExitPrice: 57_500,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
    }));

    expect(outcome.underlying!.resolutionBasis).toBe("ENDPOINT");
    expect(outcome.underlying!.excursionTimeframe).toBeNull();
  });

  it("keeps the underlying excursions null when no path was read", () => {
    // Zero would claim the underlying never moved against the thesis, and `reconcileOutcome` refuses
    // a timeframe with no measurement behind it -- which is what stops this decorating.
    const { outcome } = layeredOutcomeFromClosedTrade(trade({
      underlyingExitPrice: 57_500,
      underlyingThesis: { direction: "LONG", stop: 57_200, target: 57_800 },
    }));

    expect(outcome.underlying!.favourableExcursion).toBeNull();
    expect(outcome.underlying!.adverseExcursion).toBeNull();
    expect(outcome.underlying!.excursionTimeframe).toBeNull();
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
     * Corrected by the data, twice. The first version reported a partially exited trade as
     * NOT_COMPARABLE, reasoning that `(exit - entry) x quantity` cannot hold when `exitPrice` is one
     * slice's price. That exclusion would have discarded all but one of the real closed trades and the
     * detector would have reported nothing at all, so the flag travels instead of filtering.
     *
     * The second correction is why the identity holds. It is not that `exitPrice` reconciles across
     * tranches -- migration 088's audit found that every close to date is a *single* slice covering
     * the full quantity (338 of 339 as of 2026-09-01), so the identity holds trivially. A real
     * multi-slice close has never occurred; when one does, the residual it produces will be a
     * data-shape change rather than a defect.
     */
    const adapted = layeredOutcomeFromClosedTrade(trade({ hasPartialExits: true }));

    expect(adapted.hasPartialExits).toBe(true);
    expect(adapted.unexplainedResidual).toBe(0);
  });

  it("reproduces the one real anomaly: P&L booked gross where fees were expected", () => {
    /*
     * Trade 951a0ecb on 2026-08-31: the only closed trade whose `realized_pnl` is gross rather than
     * net of fees, and the only one with no slice row. Its residual is exactly its fees.
     *
     * Its cause is settled and is not a code path -- it was closed by a hand-written `UPDATE` at
     * 19:18 IST, four hours after the close, at a price equal to its own stop loss. See migration 088.
     *
     * Pinned as a regression anyway: it is the shape the detector is for, and it was found by running
     * the adapter over real data rather than by reasoning about it.
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
