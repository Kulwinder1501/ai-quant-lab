import { describe, expect, it } from "vitest";
import type { CanonicalMarketBar } from "../domain/adapters.js";
import type { AsReportedFundamental, CanonicalFact, CorporateActionRecord } from "../domain/canonical.js";
import { STOCK_INTELLIGENCE_FEATURE_NAMES } from "../domain/feature-catalog.js";
import { MOMENTUM_6M_BARS, computeFeatureSet, type FeatureEngineInput } from "../domain/feature-engines.js";
import { ExtractionProvenanceError } from "../domain/extraction.js";
import { LookaheadViolationError } from "../../research/domain/lookahead-guard.js";
import { generateFeatureSet } from "./generate-features.js";
import { RecordExtractedFacts } from "./record-extracted-facts.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { stockIntelligenceVersions } from "../domain/versions.js";

function bar(instrumentId: string, day: string, close: string): CanonicalMarketBar {
  const openTime = new Date(`${day}T00:00:00.000Z`);
  return {
    instrumentId,
    openTime,
    closeTime: openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
    publishedAt: openTime,
    effectiveAt: openTime,
    availableAt: openTime,
  };
}

function series(instrumentId: string, fromDay: string, count: number, closeAt: (index: number) => number): CanonicalMarketBar[] {
  const start = new Date(`${fromDay}T00:00:00.000Z`);
  const bars: CanonicalMarketBar[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = new Date(start.getTime() + index * 86_400_000);
    bars.push(bar(instrumentId, day.toISOString().slice(0, 10), String(closeAt(index))));
  }
  return bars;
}

function snapshot(overrides: Partial<AsReportedFundamental> & Pick<AsReportedFundamental, "field" | "value">): AsReportedFundamental {
  const at = overrides.availableAt ?? new Date("2015-01-15T00:00:00.000Z");
  return {
    snapshotId: overrides.snapshotId ?? `${overrides.field}-${overrides.periodEnd ?? "p"}`,
    instrumentId: overrides.instrumentId ?? "inst-1",
    field: overrides.field,
    value: overrides.value,
    origin: overrides.origin ?? "REPORTED_ACTUAL",
    reportDate: overrides.reportDate ?? "2014-12-31",
    periodEnd: overrides.periodEnd ?? "2014-12-31",
    publishedAt: overrides.publishedAt ?? at,
    effectiveAt: overrides.effectiveAt ?? at,
    availableAt: at,
    dataSchemaVersion: "v0.1",
  };
}

function baseInput(overrides: Partial<FeatureEngineInput> = {}): FeatureEngineInput {
  return {
    instrumentId: "inst-1",
    asOf: new Date("2016-01-31T23:59:59.999Z"),
    bars: [],
    fundamentals: [],
    actions: [],
    facts: [],
    ...overrides,
  };
}

describe("feature catalog", () => {
  it("is the frozen 20-name M01 set", () => {
    expect(STOCK_INTELLIGENCE_FEATURE_NAMES).toHaveLength(20);
    expect(new Set(STOCK_INTELLIGENCE_FEATURE_NAMES).size).toBe(20);
  });
});

describe("technical engine", () => {
  it("computes 6m momentum from PIT closes and ignores a later bar", () => {
    const past = series("inst-1", "2015-07-01", MOMENTUM_6M_BARS + 1, (index) => (index === MOMENTUM_6M_BARS ? 110 : 100));
    const withFuture = [...past, bar("inst-1", "2016-03-01", "999")];
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const baseline = computeFeatureSet(baseInput({ asOf, bars: past }));
    const injected = computeFeatureSet(baseInput({ asOf, bars: withFuture }));
    const momentum = baseline.find((row) => row.name === "momentum_6m");
    expect(momentum?.unavailableReason).toBeNull();
    expect(momentum?.value).toBeCloseTo(0.1, 8);
    expect(injected.find((row) => row.name === "momentum_6m")?.value).toBe(momentum?.value);
  });

  it("raises RSI on a steadily rising series once 14 closes exist", () => {
    const bars = series("inst-1", "2015-12-01", 20, (index) => 100 + index);
    const rsi = computeFeatureSet(baseInput({
      asOf: new Date("2016-01-31T23:59:59.999Z"),
      bars,
    })).find((row) => row.name === "rsi_14d");
    expect(rsi?.unavailableReason).toBeNull();
    expect(Number(rsi?.value)).toBeGreaterThan(70);
  });
});

describe("fundamental, valuation, event, macro engines", () => {
  it("scores completeness from as-reported snapshots and leaves missing fields unavailable", () => {
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const fundamentals = [
      snapshot({ field: "revenue_ttm", value: "100", periodEnd: "2014-12-31", availableAt: new Date("2015-02-01T00:00:00.000Z") }),
      snapshot({ field: "revenue_ttm", value: "120", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z"), snapshotId: "rev-2" }),
      snapshot({ field: "net_income_ttm", value: "12", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z") }),
      snapshot({ field: "roe", value: "0.18", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z") }),
      snapshot({ field: "total_debt", value: "40", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z") }),
      snapshot({ field: "eps_ttm", value: "10", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z") }),
      snapshot({ field: "book_value_per_share", value: "50", periodEnd: "2015-12-31", availableAt: new Date("2016-01-15T00:00:00.000Z") }),
    ];
    const bars = [bar("inst-1", "2016-01-29", "200")];
    const generated = generateFeatureSet(baseInput({ asOf, bars, fundamentals }));
    expect(generated.features).toHaveLength(20);
    expect(generated.features.find((row) => row.name === "revenue_growth_yoy")?.value).toBeCloseTo(0.2, 8);
    expect(generated.features.find((row) => row.name === "net_margin_ttm")?.value).toBeCloseTo(0.1, 8);
    expect(generated.features.find((row) => row.name === "pe_ttm")?.value).toBeCloseTo(20, 8);
    expect(generated.features.find((row) => row.name === "pb_ttm")?.value).toBeCloseTo(4, 8);
    expect(generated.features.find((row) => row.name === "debt_to_equity")?.unavailableReason).toBe("MISSING_SHAREHOLDERS_EQUITY");
    expect(generated.features.find((row) => row.name === "ev_to_ebitda")?.unavailableReason).toBe("MISSING_FUNDAMENTAL");
    expect(generated.features.find((row) => row.name === "macro_regime")?.unavailableReason).toBe("ADAPTER_NOT_IMPLEMENTED");
    expect(generated.features.find((row) => row.name === "liquidity_regime")?.unavailableReason).toBe("ADAPTER_NOT_IMPLEMENTED");
    expect(generated.fundamentalCompleteness).toBeGreaterThan(0);
    expect(generated.fundamentalCompleteness).toBeLessThan(1);
  });

  it("flags a recent split and computes dividend yield from cash dividends over last price", () => {
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const actions: CorporateActionRecord[] = [
      {
        actionId: "ca-1",
        instrumentId: "inst-1",
        actionType: "SPLIT",
        exDate: "2016-01-10",
        details: {},
        publishedAt: new Date("2016-01-10T00:00:00.000Z"),
        effectiveAt: new Date("2016-01-10T00:00:00.000Z"),
        availableAt: new Date("2016-01-10T00:00:00.000Z"),
      },
      {
        actionId: "ca-2",
        instrumentId: "inst-1",
        actionType: "DIVIDEND",
        exDate: "2015-06-01",
        details: { amountPerShare: 5 },
        publishedAt: new Date("2015-06-01T00:00:00.000Z"),
        effectiveAt: new Date("2015-06-01T00:00:00.000Z"),
        availableAt: new Date("2015-06-01T00:00:00.000Z"),
      },
    ];
    const generated = generateFeatureSet(baseInput({
      asOf,
      bars: [bar("inst-1", "2016-01-29", "100")],
      actions,
    }));
    expect(generated.features.find((row) => row.name === "corporate_action_flag")?.value).toBe(1);
    expect(generated.features.find((row) => row.name === "dividend_yield")?.value).toBeCloseTo(0.05, 8);
  });

  it("computes sector relative strength as stock 6m momentum minus Nifty 6m momentum", () => {
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const stock = series("inst-1", "2015-07-01", MOMENTUM_6M_BARS + 1, (index) => (index === MOMENTUM_6M_BARS ? 120 : 100));
    const nifty = series("idx", "2015-07-01", MOMENTUM_6M_BARS + 1, (index) => (index === MOMENTUM_6M_BARS ? 110 : 100));
    const relative = computeFeatureSet(baseInput({ asOf, bars: stock, indexBars: nifty }))
      .find((row) => row.name === "sector_relative_strength_6m");
    expect(relative?.value).toBeCloseTo(0.1, 8);
  });

  it("uses an earnings surprise only when the estimate was knowable at asOf", () => {
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const fundamentals = [
      snapshot({
        field: "eps_ttm",
        value: "10",
        origin: "ANALYST_ESTIMATE",
        periodEnd: "2015-12-31",
        availableAt: new Date("2015-12-01T00:00:00.000Z"),
        snapshotId: "est",
      }),
      snapshot({
        field: "eps_ttm",
        value: "12",
        origin: "REPORTED_ACTUAL",
        periodEnd: "2015-12-31",
        availableAt: new Date("2016-01-15T00:00:00.000Z"),
        snapshotId: "act",
      }),
    ];
    const surprise = generateFeatureSet(baseInput({ asOf, fundamentals }))
      .features.find((row) => row.name === "earnings_surprise_recent");
    expect(surprise?.value).toBeCloseTo(0.2, 8);

    const leakedEstimate = generateFeatureSet(baseInput({
      asOf,
      fundamentals: [
        ...fundamentals,
        snapshot({
          field: "eps_ttm",
          value: "20",
          origin: "ANALYST_ESTIMATE",
          periodEnd: "2015-12-31",
          availableAt: new Date("2016-02-01T00:00:00.000Z"),
          snapshotId: "future-est",
        }),
      ],
    })).features.find((row) => row.name === "earnings_surprise_recent");
    expect(leakedEstimate?.value).toBeCloseTo(0.2, 8);
  });
});

describe("RecordExtractedFacts", () => {
  function factStore() {
    const facts: CanonicalFact[] = [];
    const store = {
      insertFact: async (record: Omit<CanonicalFact, "factId"> & { factId?: string }) => {
        const factId = record.factId ?? `fact-${facts.length + 1}`;
        facts.push({ ...record, factId, sourceRawId: record.sourceRawId ?? null });
        return factId;
      },
    } as unknown as StockIntelligenceStore;
    return { store, facts };
  }

  it("refuses a fact without provenance and refuses a price forecast name", async () => {
    const { store } = factStore();
    const recorder = new RecordExtractedFacts(store);
    const cutoff = new Date("2016-01-31T00:00:00.000Z");
    await expect(recorder.execute({
      dataCutoff: cutoff,
      drafts: [{
        instrumentId: "inst-1",
        factName: "capex_guidance",
        factValue: { amount: 1 },
        sourceDocument: "",
        extractionModel: "gpt-test",
        publishedAt: cutoff,
        effectiveAt: cutoff,
        availableAt: cutoff,
      }],
    })).rejects.toBeInstanceOf(ExtractionProvenanceError);

    await expect(recorder.execute({
      dataCutoff: cutoff,
      drafts: [{
        instrumentId: "inst-1",
        factName: "predicted_return",
        factValue: { value: 0.1 },
        sourceDocument: "filing.pdf",
        extractionModel: "gpt-test",
        publishedAt: cutoff,
        effectiveAt: cutoff,
        availableAt: cutoff,
      }],
    })).rejects.toBeInstanceOf(ExtractionProvenanceError);
  });

  it("refuses extracted facts knowable after the data cutoff", async () => {
    const { store } = factStore();
    await expect(new RecordExtractedFacts(store).execute({
      dataCutoff: new Date("2016-01-31T00:00:00.000Z"),
      drafts: [{
        instrumentId: "inst-1",
        factName: "order_book",
        factValue: { value: 1 },
        sourceDocument: "filing.pdf",
        extractionModel: "gpt-test",
        publishedAt: new Date("2016-02-01T00:00:00.000Z"),
        effectiveAt: new Date("2016-02-01T00:00:00.000Z"),
        availableAt: new Date("2016-02-01T00:00:00.000Z"),
      }],
    })).rejects.toBeInstanceOf(LookaheadViolationError);
  });

  it("stores a provenance-complete fact", async () => {
    const { store, facts } = factStore();
    const cutoff = new Date("2016-01-31T00:00:00.000Z");
    const result = await new RecordExtractedFacts(store).execute({
      dataCutoff: cutoff,
      drafts: [{
        instrumentId: "inst-1",
        factName: "order_book",
        factValue: { value: 42 },
        sourceDocument: "annual-report.pdf",
        sourcePage: 12,
        extractionModel: "gpt-test",
        publishedAt: cutoff,
        effectiveAt: cutoff,
        availableAt: cutoff,
      }],
    });
    expect(result.inserted).toBe(1);
    expect(facts[0]?.sourceDocument).toBe("annual-report.pdf");
    expect(facts[0]?.extractionVersion).toBe(stockIntelligenceVersions.extraction);
  });
});

describe("empty engines", () => {
  it("returns twenty unavailable-or-zero rows when there is no history", () => {
    const generated = generateFeatureSet(baseInput());
    expect(generated.features).toHaveLength(20);
    expect(generated.features.find((row) => row.name === "corporate_action_flag")?.value).toBe(0);
    expect(generated.availableCount).toBe(1);
    expect(generated.fundamentalCompleteness).toBe(0);
    expect(generated.documentCoverage).toBe(0);
  });
});
