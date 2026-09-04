import { describe, expect, it } from "vitest";
import type { CanonicalFeature, CanonicalRawRecord, CanonicalSignal } from "../domain/canonical.js";
import type { PredictionDecayMark } from "../domain/decay.js";
import type { PredictionSnapshot } from "../domain/snapshot.js";
import {
  barFromHistoricalCandle,
  YAHOO_DAILY_BAR_SOURCE_KIND,
  type CanonicalMarketBar,
  type MarketDataAdapter,
} from "../domain/adapters.js";
import { marketDataCompleteness } from "../domain/data-quality.js";
import {
  assertNoBarFutureInjection,
  detectBarFutureInjection,
  selectBarsAsOf,
} from "../domain/pit-audit.js";
import {
  buildReplayPairs,
  HISTORICAL_REPLAY_WINDOW_FROM,
  HISTORICAL_REPLAY_WINDOW_TO,
  monthlyMonthEndCutoffs,
  pairKey,
  REPLAY_SURVIVORSHIP_LIMITATION,
} from "../domain/replay.js";
import type { InstrumentAlias, StockIntelligenceStore } from "../domain/store.js";
import type { InstrumentExistence, UniverseMembership } from "../domain/universe.js";
import { stockIntelligenceVersions } from "../domain/versions.js";
import { IngestMarketBars, yahooCollectionBlockReason } from "./ingest-market-bars.js";
import { RunHistoricalReplay } from "./run-historical-replay.js";
import { evaluateGate7 } from "../domain/gate7.js";
import type { Gate7Report } from "../domain/gate7.js";
import { RunGate7Acceptance } from "./run-gate7-acceptance.js";
import type { HistoricalMarketCandle } from "../../market-data/domain/historical-data-provider.js";

function memoryStore(): StockIntelligenceStore {
  const aliases = new Map<string, string>();
  const memberships = new Map<string, UniverseMembership[]>();
  const existence: InstrumentExistence[] = [];
  const raw: CanonicalRawRecord[] = [];
  const features: CanonicalFeature[] = [];
  const signals: CanonicalSignal[] = [];
  const snapshots: PredictionSnapshot[] = [];
  const decayMarks: PredictionDecayMark[] = [];
  const gate7Reports: Gate7Report[] = [];
  const jobs = new Map<string, Awaited<ReturnType<StockIntelligenceStore["createReplayJob"]>>>();
  const pairResults = new Map<string, Awaited<ReturnType<StockIntelligenceStore["listReplayPairResults"]>>>();
  let rawSeq = 0;
  let jobSeq = 0;
  let featureSeq = 0;
  let signalSeq = 0;

  return {
    findAlias: async (alias) => aliases.get(alias) ?? null,
    upsertAlias: async (alias: InstrumentAlias) => {
      aliases.set(alias.alias, alias.instrumentId);
    },
    listMemberships: async (instrumentId) => memberships.get(instrumentId) ?? [],
    listAllMemberships: async (universes) => {
      const rows = [...memberships.values()].flat();
      return universes ? rows.filter((row) => universes.includes(row.universe)) : rows;
    },
    upsertMembership: async (membership) => {
      const current = memberships.get(membership.instrumentId) ?? [];
      current.push(membership);
      memberships.set(membership.instrumentId, current);
    },
    findExistenceAsOf: async (instrumentId, asOf) => {
      const covering = existence
        .filter((row) => row.instrumentId === instrumentId && row.availableAt.getTime() <= asOf.getTime())
        .sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
      return covering[0] ?? null;
    },
    listAllExistence: async () => [...existence],
    upsertExistence: async (row) => {
      existence.push(row);
    },
    insertRaw: async (record) => {
      const existing = raw.find((row) =>
        row.instrumentId === record.instrumentId
        && row.sourceKind === record.sourceKind
        && row.effectiveAt.getTime() === record.effectiveAt.getTime()
      );
      if (existing) return existing.rawId;
      const rawId = record.rawId ?? `raw-${++rawSeq}`;
      raw.push({ ...record, rawId, instrumentId: record.instrumentId });
      return rawId;
    },
    listRawAsOf: async (instrumentId, dataCutoff, sourceKind) =>
      raw.filter((row) =>
        row.instrumentId === instrumentId
        && row.availableAt.getTime() <= dataCutoff.getTime()
        && (sourceKind === undefined || row.sourceKind === sourceKind)
      ),
    insertFact: async () => "fact",
    insertFeature: async (record) => {
      const existing = features.find((row) =>
        row.instrumentId === record.instrumentId
        && row.featureName === record.featureName
        && row.effectiveAt.getTime() === record.effectiveAt.getTime()
        && row.featureVersion === record.featureVersion
      );
      if (existing) return existing.featureId;
      const featureId = record.featureId ?? `feature-${++featureSeq}`;
      features.push({ ...record, featureId, derivedFromFactIds: record.derivedFromFactIds });
      return featureId;
    },
    listFeaturesAsOf: async (instrumentId, dataCutoff) =>
      features.filter((row) => row.instrumentId === instrumentId && row.availableAt.getTime() <= dataCutoff.getTime()),
    listFeaturesBefore: async (before) =>
      features.filter((row) => row.availableAt.getTime() < before.getTime()),
    insertSignal: async (record) => {
      const signalId = record.signalId ?? `signal-${++signalSeq}`;
      signals.push({ ...record, signalId });
      return signalId;
    },
    insertFundamentalSnapshot: async () => "fund",
    insertCorporateAction: async () => "action",
    listCorporateActionsAsOf: async () => [],
    listFactsAsOf: async () => [],
    listSignalsAsOf: async (instrumentId, dataCutoff) =>
      signals.filter((row) => row.instrumentId === instrumentId && row.availableAt.getTime() <= dataCutoff.getTime()),
    listSignalsBefore: async (before, signalName) =>
      signals.filter((row) => row.signalName === signalName && row.availableAt.getTime() < before.getTime()),
    listFundamentalsAsOf: async () => [],
    createReplayJob: async (input) => {
      const job = {
        jobId: `job-${++jobSeq}`,
        status: "RUNNING" as const,
        jobKind: input.jobKind ?? "monthly_data_replay" as const,
        completedPairs: [],
        remainingPairs: [...input.remainingPairs],
        lastCheckpoint: new Date("2015-01-31T00:00:00.000Z"),
        pipelineVersions: input.pipelineVersions,
        windowFrom: input.windowFrom ?? null,
        windowTo: input.windowTo ?? null,
      };
      jobs.set(job.jobId, job);
      pairResults.set(job.jobId, []);
      return job;
    },
    getReplayJob: async (jobId) => jobs.get(jobId) ?? null,
    checkpointReplayJob: async (input) => {
      const job = jobs.get(input.jobId);
      if (!job) throw new Error("missing job");
      jobs.set(input.jobId, {
        ...job,
        status: input.status,
        completedPairs: [...input.completedPairs],
        remainingPairs: [...input.remainingPairs],
        lastCheckpoint: new Date("2015-02-01T00:00:00.000Z"),
      });
    },
    insertReplayPairResult: async (result) => {
      const rows = pairResults.get(result.jobId) ?? [];
      if (rows.some((row) => pairKey(row) === pairKey(result))) return;
      rows.push(result);
      pairResults.set(result.jobId, rows);
    },
    listReplayPairResults: async (jobId) => pairResults.get(jobId) ?? [],
    insertSnapshot: async (record) => {
      const existing = snapshots.find((row) =>
        row.instrumentId === record.instrumentId
        && row.horizon === record.horizon
        && row.predictionAsOf.getTime() === record.predictionAsOf.getTime()
        && row.versions.outcomeModel === record.versions.outcomeModel
        && row.versions.calibrationModel === record.versions.calibrationModel
      );
      if (existing) return existing.snapshotId;
      const snapshotId = record.snapshotId ?? `snap-${snapshots.length + 1}`;
      snapshots.push({ ...record, snapshotId });
      return snapshotId;
    },
    listSnapshotsAsOf: async (instrumentId, dataCutoff) =>
      snapshots.filter((row) => row.instrumentId === instrumentId && row.availableAt.getTime() <= dataCutoff.getTime()),
    listSnapshotsAvailableAt: async (dataCutoff) =>
      snapshots.filter((row) => row.availableAt.getTime() <= dataCutoff.getTime()),
    insertDecayMark: async (record) => {
      const markId = record.markId ?? `mark-${decayMarks.length + 1}`;
      decayMarks.push({ ...record, markId });
      return markId;
    },
    listDecayMarks: async (snapshotId) => decayMarks.filter((row) => row.snapshotId === snapshotId),
    listHoldings: async () => [],
    listInvestorWatchlist: async () => [],
    insertGate7Report: async (record) => {
      const reportId = record.reportId ?? `gate7-${gate7Reports.length + 1}`;
      gate7Reports.push(record);
      return reportId;
    },
    latestGate7Report: async (jobId, horizon) =>
      [...gate7Reports].reverse().find((row) => row.jobId === jobId && row.horizon === horizon) ?? null,
  };
}

function bar(instrumentId: string, day: string, close = "100"): CanonicalMarketBar {
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

function candle(day: string, close = "100"): HistoricalMarketCandle {
  const openTime = new Date(`${day}T00:00:00.000Z`);
  return {
    openTime,
    closeTime: openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
  };
}

describe("monthly replay grid", () => {
  it("emits 120 month-end cutoffs from 2015-01 through 2024-12", () => {
    const dates = monthlyMonthEndCutoffs(
      new Date(`${HISTORICAL_REPLAY_WINDOW_FROM}T00:00:00.000Z`),
      new Date(`${HISTORICAL_REPLAY_WINDOW_TO}T00:00:00.000Z`),
    );
    expect(dates).toHaveLength(120);
    expect(dates[0]!.toISOString()).toBe("2015-01-31T23:59:59.999Z");
    expect(dates[119]!.toISOString()).toBe("2024-12-31T23:59:59.999Z");
    expect(buildReplayPairs(["a", "b"], dates).length).toBe(240);
  });
});

describe("mechanical PIT on stored bars", () => {
  const bars = [
    bar("inst-1", "2015-01-15", "10"),
    bar("inst-1", "2015-01-31", "11"),
    bar("inst-1", "2015-02-15", "12"),
  ];
  const cutoff = new Date("2015-01-31T23:59:59.999Z");

  it("keeps bars on or before cutoff and ignores corrupted future closes", () => {
    const kept = selectBarsAsOf(bars, cutoff);
    expect(kept.map((row) => row.close)).toEqual(["10", "11"]);
    const report = assertNoBarFutureInjection({ bars, cutoff });
    expect(report.leaked).toBe(false);
    expect(report.corruptedBarCount).toBe(1);
  });

  it("fails when a selector returns post-cutoff bars", () => {
    const report = detectBarFutureInjection({
      bars,
      cutoff,
      select: (all) => [...all],
    });
    expect(report.leaked).toBe(true);
  });
});

describe("IngestMarketBars", () => {
  it("refuses NIFTYNXT50 instead of guessing a Yahoo ticker", () => {
    expect(yahooCollectionBlockReason("NIFTYNXT50", "INDEX")).toBe("YAHOO_TICKER_UNVERIFIED");
    expect(yahooCollectionBlockReason("NIFTY50", "INDEX")).toBeNull();
    expect(yahooCollectionBlockReason("RELIANCE", "EQUITY")).toBeNull();
  });

  it("persists yahoo daily bars idempotently and never writes the trading candles table", async () => {
    const store = memoryStore();
    const adapter: MarketDataAdapter = {
      fetchDailyBars: async ({ instrumentId }) => [
        barFromHistoricalCandle(instrumentId, candle("2015-01-02", "100")),
        barFromHistoricalCandle(instrumentId, candle("2015-01-05", "101")),
      ],
    };
    const ingest = new IngestMarketBars(adapter, store);
    const first = await ingest.execute({
      instrumentId: "inst-1",
      symbol: "RELIANCE",
      instrumentType: "EQUITY",
      from: new Date("2015-01-01T00:00:00.000Z"),
      to: new Date("2015-01-31T23:59:59.999Z"),
      dataCutoff: new Date("2015-01-31T23:59:59.999Z"),
    });
    const second = await ingest.execute({
      instrumentId: "inst-1",
      symbol: "RELIANCE",
      instrumentType: "EQUITY",
      from: new Date("2015-01-01T00:00:00.000Z"),
      to: new Date("2015-01-31T23:59:59.999Z"),
      dataCutoff: new Date("2015-01-31T23:59:59.999Z"),
    });
    expect(first).toEqual({ fetched: 2, inserted: 2, skippedExisting: 0, skippedReason: null });
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBe(2);
    const stored = await store.listRawAsOf("inst-1", new Date("2015-01-31T23:59:59.999Z"), YAHOO_DAILY_BAR_SOURCE_KIND);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.sourceKind).toBe(YAHOO_DAILY_BAR_SOURCE_KIND);
  });
});

describe("RunHistoricalReplay", () => {
  it("marks 2015 pairs ineligible on a current-roster snapshot and still PIT-audits stored bars", async () => {
    const store = memoryStore();
    const roster = new Date("2026-09-03T00:00:00.000Z");
    await store.upsertMembership({
      instrumentId: "inst-1",
      universe: "NIFTY50",
      effectiveFrom: roster,
      effectiveTo: null,
      availableAt: roster,
      provenance: "current_roster_snapshot",
    });
    await store.upsertExistence({
      instrumentId: "inst-1",
      listedFrom: null,
      listedTo: null,
      availableAt: roster,
    });
    await store.insertRaw({
      instrumentId: "inst-1",
      sourceKind: YAHOO_DAILY_BAR_SOURCE_KIND,
      payload: {
        openTime: "2015-01-15T00:00:00.000Z",
        closeTime: "2015-01-15T00:00:00.000Z",
        open: "10",
        high: "10",
        low: "10",
        close: "10",
        volume: "1",
        priceSeriesBasis: "split_adjusted",
      },
      publishedAt: new Date("2015-01-15T00:00:00.000Z"),
      effectiveAt: new Date("2015-01-15T00:00:00.000Z"),
      availableAt: new Date("2015-01-15T00:00:00.000Z"),
      dataSchemaVersion: "v0.1",
    });
    await store.insertRaw({
      instrumentId: "inst-1",
      sourceKind: YAHOO_DAILY_BAR_SOURCE_KIND,
      payload: {
        openTime: "2015-02-15T00:00:00.000Z",
        closeTime: "2015-02-15T00:00:00.000Z",
        open: "12",
        high: "12",
        low: "12",
        close: "12",
        volume: "1",
        priceSeriesBasis: "split_adjusted",
      },
      publishedAt: new Date("2015-02-15T00:00:00.000Z"),
      effectiveAt: new Date("2015-02-15T00:00:00.000Z"),
      availableAt: new Date("2015-02-15T00:00:00.000Z"),
      dataSchemaVersion: "v0.1",
    });

    const pairs = buildReplayPairs(
      ["inst-1"],
      monthlyMonthEndCutoffs(new Date("2015-01-01T00:00:00.000Z"), new Date("2015-02-28T00:00:00.000Z")),
    );
    const first = await new RunHistoricalReplay(store).execute({
      pairs,
      windowFrom: "2015-01-01",
      windowTo: "2015-02-28",
      interruptAfter: 1,
    });
    expect(first.job.status).toBe("PAUSED");
    expect(first.job.remainingPairs).toHaveLength(1);
    expect(first.summary.nSimulated).toBe(1);
    expect(first.summary.censoredReasons.MEMBERSHIP_NOT_YET_AVAILABLE).toBe(1);
    expect(first.summary.nPitPassed).toBe(1);
    expect(first.summary.nFullyEvaluated).toBe(0);
    expect(first.summary.survivorshipLimitation).toBe(REPLAY_SURVIVORSHIP_LIMITATION);

    const resumed = await new RunHistoricalReplay(store).execute({
      pairs,
      windowFrom: "2015-01-01",
      windowTo: "2015-02-28",
      jobId: first.job.jobId,
    });
    expect(resumed.job.status).toBe("COMPLETE");
    expect(resumed.job.remainingPairs).toHaveLength(0);
    expect(resumed.summary.nSimulated).toBe(2);
    expect(resumed.summary.nPitFailed).toBe(0);
    expect(resumed.job.pipelineVersions.replayHarness).toBe(stockIntelligenceVersions.replayHarness);

    const january = (await store.listReplayPairResults(first.job.jobId))
      .find((row) => row.asOf === "2015-01-31");
    expect(january?.marketBarCount).toBe(1);
    expect(january?.status).toBe("SKIPPED_INELIGIBLE");
    expect(january?.censorship.analogueEffectiveSampleSize6m).toBe(0);
    expect(january?.censorship.analogueEffectiveSampleSize12m).toBe(0);
    const written = await store.listFeaturesAsOf("inst-1", new Date("2015-01-31T23:59:59.999Z"));
    expect(written).toHaveLength(20);
    const signals = await store.listSignalsAsOf("inst-1", new Date("2015-01-31T23:59:59.999Z"));
    expect(signals.map((row) => row.signalName).sort()).toEqual([
      "analogue_set_12m",
      "analogue_set_6m",
      "data_quality",
      "outcome_distribution_12m",
      "outcome_distribution_6m",
    ]);
    expect(january?.censorship.outcomeNUsed6m).toBe(0);
    const storedSnapshots = await store.listSnapshotsAsOf("inst-1", new Date("2015-01-31T23:59:59.999Z"));
    expect(storedSnapshots).toHaveLength(2);
    expect(new Set(storedSnapshots.map((row) => row.horizon))).toEqual(new Set(["6M", "12M"]));
    expect(storedSnapshots.every((row) => row.investorFacing === false)).toBe(true);

    const gate7 = evaluateGate7({
      evaluationAsOf: "2015-02-28",
      censorship: resumed.summary,
      forecasts: [],
    });
    expect(gate7.passed).toBe(false);
    expect(gate7.criteria.find((row) => row.id === 2)?.passed).toBe(false);
    expect(gate7.censoredBiasAssessment).toContain("Current-roster");
    expect(gate7.enablement.eligible).toBe(false);

    const acceptance = await new RunGate7Acceptance(store).execute({
      jobId: first.job.jobId,
      evaluationAsOf: new Date("2015-02-28T23:59:59.999Z"),
    });
    expect(acceptance.passed).toBe(false);
    expect(acceptance.enablement.eligible).toBe(false);
    expect(acceptance.horizons["6M"].passed).toBe(false);
    expect(acceptance.horizons["12M"].passed).toBe(false);
    expect(await store.latestGate7Report(first.job.jobId, "6M")).not.toBeNull();
  });

  it("records COMPLETE only when membership is knowable and bars exist", async () => {
    const store = memoryStore();
    const asOf = new Date("2015-01-31T00:00:00.000Z");
    await store.upsertMembership({
      instrumentId: "inst-1",
      universe: "NIFTY50",
      effectiveFrom: asOf,
      effectiveTo: null,
      availableAt: asOf,
      provenance: "historical_archive",
    });
    await store.upsertExistence({
      instrumentId: "inst-1",
      listedFrom: new Date("2010-01-01T00:00:00.000Z"),
      listedTo: null,
      availableAt: asOf,
    });
    for (let day = 2; day <= 30; day += 1) {
      const stamp = new Date(Date.UTC(2015, 0, day));
      await store.insertRaw({
        instrumentId: "inst-1",
        sourceKind: YAHOO_DAILY_BAR_SOURCE_KIND,
        payload: {
          openTime: stamp.toISOString(),
          closeTime: stamp.toISOString(),
          open: "10",
          high: "10",
          low: "10",
          close: "10",
          volume: "1",
        },
        publishedAt: stamp,
        effectiveAt: stamp,
        availableAt: stamp,
        dataSchemaVersion: "v0.1",
      });
    }

    const result = await new RunHistoricalReplay(store).execute({
      pairs: [{ instrumentId: "inst-1", asOf: "2015-01-31" }],
      windowFrom: "2015-01-01",
      windowTo: "2015-01-31",
    });
    expect(result.summary.nFullyEvaluated).toBe(1);
    const row = (await store.listReplayPairResults(result.job.jobId))[0]!;
    expect(row.status).toBe("COMPLETE");
    expect(row.pitPassed).toBe(true);
    expect(row.censorship.analogueEffectiveSampleSize6m).toBe(0);
    expect(row.censorship.outcomeNUsed6m).toBe(0);
    const completeSignals = await store.listSignalsAsOf("inst-1", new Date("2015-01-31T23:59:59.999Z"));
    expect(completeSignals.some((row) => row.signalName === "analogue_set_6m")).toBe(true);
    expect(completeSignals.some((row) => row.signalName === "outcome_distribution_6m")).toBe(true);
    expect(completeSignals.some((row) => row.signalName === "regime_bucket")).toBe(false);
    expect(marketDataCompleteness({
      asOf: new Date("2015-01-31T23:59:59.999Z"),
      bars: [{ availableAt: new Date("2015-01-15T00:00:00.000Z") }],
    })).toBeGreaterThan(0);
  });
});
