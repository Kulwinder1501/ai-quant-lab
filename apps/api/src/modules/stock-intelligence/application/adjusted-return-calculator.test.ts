import { describe, expect, it } from "vitest";
import type { CorporateActionRecord } from "../domain/canonical.js";
import type { InstrumentAlias, StockIntelligenceStore } from "../domain/store.js";
import type { InstrumentExistence, UniverseMembership } from "../domain/universe.js";
import { calculateAdjustedHorizonReturn } from "./adjusted-return-calculator.js";
import {
  corporateActionsFromYahooEvents,
  type CorporateActionAdapter,
  type DiscoveredCorporateAction,
} from "./corporate-action-adapter.js";
import { IngestCorporateActions } from "./ingest-corporate-actions.js";

function action(overrides: Partial<CorporateActionRecord> & Pick<CorporateActionRecord, "actionType" | "exDate">): CorporateActionRecord {
  const ex = new Date(`${overrides.exDate}T00:00:00.000Z`);
  return {
    actionId: overrides.actionId ?? `action-${overrides.exDate}`,
    instrumentId: overrides.instrumentId ?? "inst-1",
    actionType: overrides.actionType,
    exDate: overrides.exDate,
    details: overrides.details ?? {},
    publishedAt: overrides.publishedAt ?? ex,
    effectiveAt: overrides.effectiveAt ?? ex,
    availableAt: overrides.availableAt ?? ex,
  };
}

describe("adjusted horizon returns — known split and dividend cases", () => {
  /**
   * Reliance 1:1 bonus, ex 2017-09-07, is economically a 2-for-1 split.
   * As-traded: ~₹1,600 before, ~₹800 after. Entry is never rewritten.
   */
  it("restates the terminal print onto the entry share basis for a 1:1 bonus", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-06-01T00:00:00.000Z"),
      horizonEnd: new Date("2017-12-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2017-12-01T00:00:00.000Z"),
      entryPrice: 1600,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2017-06-01T00:00:00.000Z"), close: 1600 },
        { asOf: new Date("2017-09-06T00:00:00.000Z"), close: 1580 },
        { asOf: new Date("2017-09-07T00:00:00.000Z"), close: 800 },
        { asOf: new Date("2017-12-01T00:00:00.000Z"), close: 880 },
      ],
      actions: [action({
        actionType: "BONUS",
        exDate: "2017-09-07",
        details: { additionalSharesPerHeld: 1 },
      })],
    });

    expect(result.entryPrice).toBe(1600);
    expect(result.methodology.entryPriceUnchanged).toBe(true);
    expect(result.methodology.terminalAdjustmentFactor).toBe(2);
    expect(result.terminalPriceComparable).toBe(1760);
    expect(result.forwardPriceReturn).toBeCloseTo(0.10, 8);
    expect(result.forwardTotalReturn).toBeCloseTo(0.10, 8);
  });

  it("does not apply a split that falls after the horizon", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-01-01T00:00:00.000Z"),
      horizonEnd: new Date("2017-06-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2017-12-01T00:00:00.000Z"),
      entryPrice: 1600,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2017-01-01T00:00:00.000Z"), close: 1600 },
        { asOf: new Date("2017-06-01T00:00:00.000Z"), close: 1650 },
      ],
      actions: [action({
        actionType: "SPLIT",
        exDate: "2017-09-07",
        details: { numerator: 2, denominator: 1 },
      })],
    });

    expect(result.methodology.terminalAdjustmentFactor).toBe(1);
    expect(result.forwardPriceReturn).toBeCloseTo(1650 / 1600 - 1, 8);
  });

  it("does not apply a split that already sits in the recorded entry", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-10-01T00:00:00.000Z"),
      horizonEnd: new Date("2018-04-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2018-04-01T00:00:00.000Z"),
      entryPrice: 800,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2017-10-01T00:00:00.000Z"), close: 800 },
        { asOf: new Date("2018-04-01T00:00:00.000Z"), close: 880 },
      ],
      actions: [action({
        actionType: "SPLIT",
        exDate: "2017-09-07",
        details: { numerator: 2, denominator: 1 },
      })],
    });

    expect(result.methodology.priceAdjustmentsApplied).toEqual([]);
    expect(result.forwardPriceReturn).toBeCloseTo(0.10, 8);
  });

  it("adds cash dividends to total return and leaves them out of price return", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2024-01-02T00:00:00.000Z"),
      horizonEnd: new Date("2024-07-02T00:00:00.000Z"),
      evaluationCutoff: new Date("2024-07-02T00:00:00.000Z"),
      entryPrice: 1000,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2024-01-02T00:00:00.000Z"), close: 1000 },
        { asOf: new Date("2024-07-02T00:00:00.000Z"), close: 990 },
      ],
      actions: [action({
        actionType: "DIVIDEND",
        exDate: "2024-05-15",
        details: { amountPerShare: 20 },
      })],
    });

    expect(result.forwardPriceReturn).toBeCloseTo(-0.01, 8);
    expect(result.forwardTotalReturn).toBeCloseTo(0.01, 8);
    expect(result.methodology.dividendsIncludedInTotalReturn).toEqual([
      { exDate: "2024-05-15", amountPerShare: 20 },
    ]);
  });

  it("does not double-count splits when the series is already Yahoo split-adjusted", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-06-01T00:00:00.000Z"),
      horizonEnd: new Date("2017-12-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2017-12-01T00:00:00.000Z"),
      entryPrice: 800,
      priceSeriesBasis: "split_adjusted",
      pricePath: [
        { asOf: new Date("2017-06-01T00:00:00.000Z"), close: 800 },
        { asOf: new Date("2017-12-01T00:00:00.000Z"), close: 880 },
      ],
      actions: [action({
        actionType: "SPLIT",
        exDate: "2017-09-07",
        details: { numerator: 2, denominator: 1 },
      })],
    });

    expect(result.methodology.splitsIgnoredBecauseSeriesIsSplitAdjusted).toBe(true);
    expect(result.methodology.terminalAdjustmentFactor).toBe(1);
    expect(result.forwardPriceReturn).toBeCloseTo(0.10, 8);
  });

  it("ignores an action that is not yet knowable at evaluation", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-06-01T00:00:00.000Z"),
      horizonEnd: new Date("2017-12-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2017-08-01T00:00:00.000Z"),
      entryPrice: 1600,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2017-06-01T00:00:00.000Z"), close: 1600 },
        { asOf: new Date("2017-12-01T00:00:00.000Z"), close: 880 },
      ],
      actions: [action({
        actionType: "SPLIT",
        exDate: "2017-09-07",
        availableAt: new Date("2017-09-07T00:00:00.000Z"),
        details: { numerator: 2, denominator: 1 },
      })],
    });

    expect(result.methodology.terminalAdjustmentFactor).toBe(1);
    expect(result.forwardPriceReturn).toBeCloseTo(880 / 1600 - 1, 8);
  });

  it("records a delisting at last traded price instead of dropping the outcome", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2020-01-02T00:00:00.000Z"),
      horizonEnd: new Date("2020-07-02T00:00:00.000Z"),
      evaluationCutoff: new Date("2020-07-02T00:00:00.000Z"),
      entryPrice: 100,
      priceSeriesBasis: "as_traded",
      outcomeType: "DELISTED",
      pricePath: [
        { asOf: new Date("2020-01-02T00:00:00.000Z"), close: 100 },
        { asOf: new Date("2020-03-15T00:00:00.000Z"), close: 40 },
      ],
      actions: [action({ actionType: "DELISTING", exDate: "2020-03-16" })],
    });

    expect(result.outcomeType).toBe("DELISTED");
    expect(result.lastValidPriceAt).toBe("2020-03-15");
    expect(result.gapFilled).toBe(true);
    expect(result.forwardPriceReturn).toBeCloseTo(-0.60, 8);
  });

  it("flags rights issues that cannot compute TERP rather than guessing a factor", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2021-01-01T00:00:00.000Z"),
      horizonEnd: new Date("2021-07-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2021-07-01T00:00:00.000Z"),
      entryPrice: 100,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2021-01-01T00:00:00.000Z"), close: 100 },
        { asOf: new Date("2021-07-01T00:00:00.000Z"), close: 90 },
      ],
      actions: [action({ actionType: "RIGHTS", exDate: "2021-03-01", details: { held: 10 } })],
    });

    expect(result.methodology.unresolvable[0]?.reason).toMatch(/TERP/i);
    expect(result.methodology.terminalAdjustmentFactor).toBe(1);
  });

  it("measures max drawdown on the entry-comparable path, not the raw post-split print", () => {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: new Date("2017-06-01T00:00:00.000Z"),
      horizonEnd: new Date("2017-12-01T00:00:00.000Z"),
      evaluationCutoff: new Date("2017-12-01T00:00:00.000Z"),
      entryPrice: 1600,
      priceSeriesBasis: "as_traded",
      pricePath: [
        { asOf: new Date("2017-06-01T00:00:00.000Z"), close: 1600 },
        { asOf: new Date("2017-09-07T00:00:00.000Z"), close: 700 },
        { asOf: new Date("2017-12-01T00:00:00.000Z"), close: 800 },
      ],
      actions: [action({
        actionType: "SPLIT",
        exDate: "2017-09-07",
        details: { numerator: 2, denominator: 1 },
      })],
    });

    expect(result.maxDrawdown).toBeCloseTo((1400 - 1600) / 1600, 8);
  });
});

describe("Yahoo corporate-action event mapping", () => {
  const cutoff = new Date("2018-01-01T00:00:00.000Z");

  it("maps split and dividend events and drops anything after the cutoff", () => {
    const actions = corporateActionsFromYahooEvents({
      splits: { "2017-09-07": { date: "2017-09-07", numerator: 2, denominator: 1 } },
      dividends: [
        { date: "2017-08-02", amount: 5.5 },
        { date: "2018-08-02", amount: 6 },
      ],
    }, cutoff);

    expect(actions.map((row) => row.actionType)).toEqual(["SPLIT", "DIVIDEND"]);
    expect(actions[0]?.details).toMatchObject({ numerator: 2, denominator: 1, source: "yahoo" });
    expect(actions[1]?.details).toMatchObject({ amountPerShare: 5.5 });
  });
});

describe("IngestCorporateActions", () => {
  it("inserts newly fetched actions and skips ones already stored", async () => {
    const fetched: DiscoveredCorporateAction[] = [
      {
        actionType: "SPLIT",
        exDate: "2017-09-07",
        publishedAt: new Date("2017-09-07T00:00:00.000Z"),
        effectiveAt: new Date("2017-09-07T00:00:00.000Z"),
        availableAt: new Date("2017-09-07T00:00:00.000Z"),
        details: { numerator: 2, denominator: 1 },
      },
    ];
    const adapter: CorporateActionAdapter = {
      fetchActions: async () => fetched,
    };
    const inserted: string[] = [];
    const store = memoryActionStore([action({ actionType: "SPLIT", exDate: "2017-09-07" })]);
    store.insertCorporateAction = async (record) => {
      inserted.push(record.exDate);
      return "new";
    };

    const first = await new IngestCorporateActions(adapter, store).execute({
      instrumentId: "inst-1",
      symbol: "RELIANCE",
      from: new Date("2017-01-01T00:00:00.000Z"),
      to: new Date("2018-01-01T00:00:00.000Z"),
      dataCutoff: new Date("2018-01-01T00:00:00.000Z"),
    });
    expect(first).toEqual({ fetched: 1, inserted: 0, skippedExisting: 1 });
    expect(inserted).toEqual([]);
  });
});

function memoryActionStore(existing: CorporateActionRecord[]): StockIntelligenceStore {
  return {
    findAlias: async () => null,
    upsertAlias: async (_alias: InstrumentAlias) => undefined,
    listMemberships: async () => [] as UniverseMembership[],
    upsertMembership: async () => undefined,
    findExistenceAsOf: async () => null as InstrumentExistence | null,
    listAllExistence: async () => [],
    upsertExistence: async () => undefined,
    insertRaw: async () => "raw",
    listRawAsOf: async () => [],
    listAllMemberships: async () => [],
    insertFact: async () => "fact",
    insertFeature: async () => "feature",
    listFeaturesAsOf: async () => [],
    listFeaturesBefore: async () => [],
    insertSignal: async () => "signal",
    insertFundamentalSnapshot: async () => "fund",
    insertCorporateAction: async () => "action",
    listCorporateActionsAsOf: async () => existing,
    listFactsAsOf: async () => [],
    listSignalsAsOf: async () => [],
    listSignalsBefore: async () => [],
    listFundamentalsAsOf: async () => [],
    createReplayJob: async (input) => ({
      jobId: "job-test",
      status: "RUNNING",
      jobKind: input.jobKind ?? "monthly_data_replay",
      completedPairs: [],
      remainingPairs: [...input.remainingPairs],
      lastCheckpoint: null,
      pipelineVersions: input.pipelineVersions,
      windowFrom: input.windowFrom ?? null,
      windowTo: input.windowTo ?? null,
    }),
    getReplayJob: async () => null,
    checkpointReplayJob: async () => undefined,
    insertReplayPairResult: async () => undefined,
    listReplayPairResults: async () => [],
    insertSnapshot: async () => "snap",
    listSnapshotsAsOf: async () => [],
    listSnapshotsAvailableAt: async () => [],
    insertDecayMark: async () => "mark",
    listDecayMarks: async () => [],
    listHoldings: async () => [],
    listInvestorWatchlist: async () => [],
    insertGate7Report: async () => "gate7",
    latestGate7Report: async () => null,
  };
}
