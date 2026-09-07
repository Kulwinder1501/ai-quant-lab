import { describe, expect, it, vi } from "vitest";
import {
  SettleAuxiliaryPredictions,
  type AuxiliaryPredictionSettlementRepository,
  type SettleableAuxiliaryPrediction,
  type AuxiliarySettlementOutcome,
} from "./settle-auxiliary-predictions.js";
import type { RangeBar } from "../domain/volatility-expansion-label.js";

const SOURCE_CLOSE = new Date("2026-06-10T10:00:00Z");
const FORWARD_CLOSE = new Date("2026-06-17T10:00:00Z");

function pending(overrides: Partial<SettleableAuxiliaryPrediction> = {}): SettleableAuxiliaryPrediction {
  return {
    predictionId: "prediction-1",
    modelVersionId: "model-1",
    modelKey: "volatility-expansion-lightgbm--pool20-f887399b--1d--h5",
    instrumentId: "instrument-1",
    timeframe: "1d",
    prediction: "EXPANSION",
    sourceCandleCloseTime: SOURCE_CLOSE,
    horizonBars: 5,
    expansionBand: 0.25,
    ...overrides,
  };
}

function window(range: number): RangeBar[] {
  const half = range / 2;
  return [
    ...Array.from({ length: 4 }, () => ({ high: 100, low: 100 })),
    { high: 100 + half, low: 100 - half },
  ];
}

function build(options: {
  items: SettleableAuxiliaryPrediction[];
  trailing?: RangeBar[];
  forward?: RangeBar[];
  forwardCloseTime?: Date | null;
  forwardWindowClosed?: boolean;
}) {
  const recordSettlement = vi.fn(async (_outcome: AuxiliarySettlementOutcome) => undefined);
  const recordUnsettleable = vi.fn(async (_predictionId: string, _reason: string) => undefined);
  const repository: AuxiliaryPredictionSettlementRepository = {
    listSettleableVolatilityPredictions: async () => options.items,
    loadRangeWindows: async () => ({
      trailing: options.trailing ?? window(10),
      forward: options.forward ?? window(12.5),
      forwardCloseTime: options.forwardCloseTime === undefined ? FORWARD_CLOSE : options.forwardCloseTime,
      forwardWindowClosed: options.forwardWindowClosed ?? false,
    }),
    recordSettlement,
    recordUnsettleable,
  };
  return { service: new SettleAuxiliaryPredictions(repository), recordSettlement, recordUnsettleable };
}

describe("SettleAuxiliaryPredictions", () => {
  it("grades a matured prediction and records the ratio alongside the label", async () => {
    const { service, recordSettlement } = build({ items: [pending()] });

    const result = await service.execute();

    expect(result).toMatchObject({ examined: 1, settled: 1, unsettleable: 0, notYetMatured: 0 });
    expect(result.byRealizedLabel).toEqual({ EXPANSION: 1 });
    expect(recordSettlement).toHaveBeenCalledOnce();
    const outcome = recordSettlement.mock.calls[0]![0];
    expect(outcome).toMatchObject({
      predictionId: "prediction-1",
      realizedLabel: "EXPANSION",
      labelAvailableAt: FORWARD_CLOSE,
    });
    // The ratio is stored because the label is only a thresholded view of it: a band
    // change must be re-scorable from history rather than invalidating settled rows.
    expect(outcome.rangeRatio).toBeCloseTo(1.25, 8);
  });

  it("settles against the realised outcome, not the prediction", async () => {
    // The model said EXPANSION; the range actually contracted.
    const { service, recordSettlement } = build({
      items: [pending({ prediction: "EXPANSION" })],
      forward: window(8),
    });

    await service.execute();

    expect(recordSettlement.mock.calls[0]![0].realizedLabel).toBe("CONTRACTION");
  });

  // An immature prediction must stay pending, not be written as anything.
  it("leaves an unmatured prediction pending without recording an outcome", async () => {
    const { service, recordSettlement, recordUnsettleable } = build({
      items: [pending()],
      forward: window(10).slice(0, 2),
    });

    const result = await service.execute();

    expect(result).toMatchObject({ settled: 0, notYetMatured: 1, unsettleable: 0 });
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(recordUnsettleable).not.toHaveBeenCalled();
  });

  it("censors an intraday prediction when its session ended before the horizon", async () => {
    const { service, recordSettlement, recordUnsettleable } = build({
      items: [pending({ timeframe: "1m" })],
      forward: window(10).slice(0, 2),
      forwardWindowClosed: true,
    });

    const result = await service.execute();

    expect(result).toMatchObject({ settled: 0, notYetMatured: 0, unsettleable: 1 });
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(recordUnsettleable).toHaveBeenCalledWith(
      "prediction-1",
      "INTRADAY_SESSION_ENDED_BEFORE_HORIZON",
    );
  });

  // A flat trailing window is a permanent property of the data, so it is recorded to
  // stop being retried -- but never as STABLE, which would manufacture agreement
  // exactly where the evidence is absent.
  it("records an ungradeable prediction with a reason rather than a STABLE outcome", async () => {
    const { service, recordSettlement, recordUnsettleable } = build({
      items: [pending()],
      trailing: Array.from({ length: 5 }, () => ({ high: 100, low: 100 })),
    });

    const result = await service.execute();

    expect(result).toMatchObject({ settled: 0, unsettleable: 1 });
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(recordUnsettleable).toHaveBeenCalledWith("prediction-1", expect.stringMatching(/trailing range/));
  });

  it.each([
    ["a missing horizon", { horizonBars: null }],
    ["a missing band", { expansionBand: null }],
    ["a non-positive band", { expansionBand: 0 }],
  ])("skips a model with %s instead of assuming a rule", async (_label, overrides) => {
    const { service, recordSettlement } = build({ items: [pending(overrides)] });

    const result = await service.execute();

    expect(result).toMatchObject({ settled: 0, skippedWithoutProtocol: 1 });
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  // The table is not value-constrained because it serves every non-directional
  // scheme, so a directional label arriving here means the alphabets have crossed.
  it("refuses to grade a directional label", async () => {
    const { service, recordSettlement } = build({ items: [pending({ prediction: "BULLISH" })] });

    const result = await service.execute();

    expect(result).toMatchObject({ settled: 0, skippedWithForeignAlphabet: 1 });
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  it("uses each model's own band, so two models grade the same bars differently", async () => {
    const { service, recordSettlement } = build({
      items: [
        pending({ predictionId: "narrow-band", expansionBand: 0.25 }),
        pending({ predictionId: "wide-band", expansionBand: 0.5 }),
      ],
    });

    const result = await service.execute();

    expect(result.settled).toBe(2);
    expect(recordSettlement.mock.calls.map((call) => [call[0]!.predictionId, call[0]!.realizedLabel])).toEqual([
      ["narrow-band", "EXPANSION"],
      ["wide-band", "STABLE"],
    ]);
  });

  it("rejects a non-positive batch limit", async () => {
    const { service } = build({ items: [] });
    await expect(service.execute({ limit: 0 })).rejects.toThrow(/positive integer/);
  });
});
