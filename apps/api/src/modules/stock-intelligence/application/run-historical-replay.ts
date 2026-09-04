import { marketDataCompleteness } from "../domain/data-quality.js";
import {
  auditBarsPointInTime,
  detectBarFutureInjection,
  selectBarsAsOf,
} from "../domain/pit-audit.js";
import {
  currentReplayVersions,
  pairKey,
  remainingAfterCompleted,
  summarizeReplayResults,
  type ReplayJob,
  type ReplayJobSummary,
  type ReplayPair,
  type ReplayPairResult,
  type ReplayPairStatus,
} from "../domain/replay.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { isEligibleAt } from "../domain/universe.js";
import type { UniverseMembership } from "../domain/universe.js";
import {
  PersistAnalogueSets,
  regimeSignal,
  snapshotFromGeneratedFeatures,
} from "./persist-analogues.js";
import { PersistGeneratedFeatures } from "./generate-features.js";
import { loadStoredMarketBars } from "./ingest-market-bars.js";
import { measureRealizedHorizon } from "./measure-realized-return.js";
import { PersistPredictionSnapshots } from "./persist-snapshots.js";
import {
  PredictHorizonOutcomes,
  calibrationObservationFromSignal,
  outcomeSignalName,
} from "./predict-outcomes.js";
import { assignRegime } from "../domain/regime-engine.js";
import { horizonEndUtc } from "../domain/outcome-model.js";
import { utcDateKey } from "../domain/returns.js";
import { REGIME_SIGNAL_NAME, snapshotsFromFeatureRows } from "../domain/analogue-search.js";
import { ReplayRuntimeCache } from "./replay-runtime-cache.js";
import type { CanonicalSignal } from "../domain/canonical.js";
import type { StockIntelligenceHorizon } from "../domain/data-quality.js";

function asOfCutoff(asOfDay: string): Date {
  return new Date(`${asOfDay}T23:59:59.999Z`);
}

/** Far enough past the replay window that `list*Before` returns every stored row. */
const CACHE_SEED_BEFORE = new Date("2099-12-31T23:59:59.999Z");

export class RunHistoricalReplay {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    pairs: readonly ReplayPair[];
    windowFrom: string;
    windowTo: string;
    jobId?: string;
    batchSize?: number;
    interruptAfter?: number;
    indexInstrumentId?: string;
    vixInstrumentId?: string;
    /** When resuming a mixed-universe job, only process instruments present in `pairs`. */
    scopeToInputPairs?: boolean;
  }): Promise<{ job: ReplayJob; summary: ReplayJobSummary }> {
    const versions = currentReplayVersions();
    let job: ReplayJob;
    if (input.jobId) {
      const existing = await this.store.getReplayJob(input.jobId);
      if (!existing) throw new Error(`Replay job ${input.jobId} was not found.`);
      job = existing;
    } else {
      job = await this.store.createReplayJob({
        remainingPairs: input.pairs,
        jobKind: "monthly_data_replay",
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        pipelineVersions: versions,
      });
    }

    const batchSize = input.batchSize ?? 100;
    // Crash between insertReplayPairResult and checkpoint can leave results ahead of
    // completed_pairs. Rebuild progress from pair_results so resume cannot loop forever
    // on orphan remaining pairs, and cannot re-insert duplicates.
    const alreadyDone = new Set((await this.store.listReplayPairResults(job.jobId)).map(pairKey));
    const scopedInstruments = input.scopeToInputPairs
      ? new Set(input.pairs.map((pair) => pair.instrumentId))
      : null;
    const allPairsByKey = new Map<string, ReplayPair>();
    for (const pair of [...job.completedPairs, ...job.remainingPairs, ...input.pairs]) {
      if (scopedInstruments && !scopedInstruments.has(pair.instrumentId)) continue;
      allPairsByKey.set(pairKey(pair), pair);
    }
    const allPairs = [...allPairsByKey.values()];
    const completed = allPairs.filter((pair) => alreadyDone.has(pairKey(pair)));
    const queue = allPairs.filter((pair) => !alreadyDone.has(pairKey(pair)));

    const barCache = new Map<string, Awaited<ReturnType<typeof loadStoredMarketBars>>>();
    const seriesCutoff = new Date(`${input.windowTo}T23:59:59.999Z`);
    const persistFeatures = new PersistGeneratedFeatures(this.store);
    const persistAnalogues = new PersistAnalogueSets(this.store);
    const persistOutcomes = new PredictHorizonOutcomes(this.store);
    const persistSnapshots = new PersistPredictionSnapshots(this.store);
    const allMemberships = await this.store.listAllMemberships();
    const membershipsByInstrument = new Map<string, typeof allMemberships>();
    for (const row of allMemberships) {
      const current = membershipsByInstrument.get(row.instrumentId) ?? [];
      current.push(row);
      membershipsByInstrument.set(row.instrumentId, current);
    }

    const runtimeCache = new ReplayRuntimeCache();
    runtimeCache.seedExistence(await this.store.listAllExistence());
    runtimeCache.features.push(...await this.store.listFeaturesBefore(CACHE_SEED_BEFORE));
    runtimeCache.regimeSignals.push(...await this.store.listSignalsBefore(CACHE_SEED_BEFORE, REGIME_SIGNAL_NAME));
    runtimeCache.outcomeSignals6m.push(
      ...await this.store.listSignalsBefore(CACHE_SEED_BEFORE, outcomeSignalName("6M")),
    );
    runtimeCache.outcomeSignals12m.push(
      ...await this.store.listSignalsBefore(CACHE_SEED_BEFORE, outcomeSignalName("12M")),
    );

    const instrumentIds = [...new Set(allPairs.map((pair) => pair.instrumentId))];
    if (input.indexInstrumentId) instrumentIds.push(input.indexInstrumentId);
    if (input.vixInstrumentId) instrumentIds.push(input.vixInstrumentId);
    for (const instrumentId of new Set(instrumentIds)) {
      const [actions, fundamentals, facts] = await Promise.all([
        this.store.listCorporateActionsAsOf(instrumentId, seriesCutoff),
        this.store.listFundamentalsAsOf(instrumentId, seriesCutoff),
        this.store.listFactsAsOf(instrumentId, seriesCutoff),
      ]);
      runtimeCache.actionsByInstrument.set(instrumentId, actions);
      runtimeCache.fundamentalsByInstrument.set(instrumentId, fundamentals);
      runtimeCache.factsByInstrument.set(instrumentId, facts);
    }

    await this.seedRealizedCalibration(runtimeCache, barCache, seriesCutoff);
    this.seedAnalogueSnapshots(runtimeCache, membershipsByInstrument);

    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence replay cache seeded",
      jobId: job.jobId,
      queue: queue.length,
      features: runtimeCache.features.length,
      analogueSnapshots: runtimeCache.analogueSnapshots.length,
      regimeSignals: runtimeCache.regimeSignals.length,
      realizedCalibration: runtimeCache.realizedCalibration.size,
      instruments: instrumentIds.length,
    }));

    let processed = 0;

    for (const pair of queue) {
      const result = await this.evaluatePair(
        job.jobId,
        pair,
        seriesCutoff,
        barCache,
        persistFeatures,
        persistAnalogues,
        persistOutcomes,
        persistSnapshots,
        membershipsByInstrument,
        runtimeCache,
        input.indexInstrumentId,
        input.vixInstrumentId,
      );
      await this.store.insertReplayPairResult(result);
      completed.push(pair);
      processed += 1;

      const remaining = remainingAfterCompleted(allPairs, completed);
      const shouldPause = input.interruptAfter !== undefined && processed >= input.interruptAfter;
      const done = remaining.length === 0;
      if (processed % batchSize === 0 || shouldPause || done) {
        // pair_results is the resume source of truth; skip rewriting huge completed_pairs JSON.
        await this.store.checkpointReplayJob({
          jobId: job.jobId,
          status: done ? "COMPLETE" : shouldPause ? "PAUSED" : "RUNNING",
          completedPairs: [],
          remainingPairs: remaining,
        });
        console.info(JSON.stringify({
          level: "info",
          message: "Stock Intelligence replay checkpoint",
          jobId: job.jobId,
          status: done ? "COMPLETE" : shouldPause ? "PAUSED" : "RUNNING",
          processedThisRun: processed,
          completed: completed.length,
          remaining: remaining.length,
        }));
      }
      if (shouldPause && !done) break;
    }

    const latest = await this.store.getReplayJob(job.jobId);
    if (!latest) throw new Error(`Replay job ${job.jobId} disappeared after checkpoint.`);
    const results = await this.store.listReplayPairResults(job.jobId);
    return { job: latest, summary: summarizeReplayResults(latest, results) };
  }

  private seedAnalogueSnapshots(
    runtimeCache: ReplayRuntimeCache,
    membershipsByInstrument: ReadonlyMap<string, UniverseMembership[]>,
  ): void {
    if (runtimeCache.features.length === 0) return;
    const regimes = new Map<string, string>();
    for (const row of runtimeCache.regimeSignals) {
      const bucket = typeof row.signalValue.bucket === "string" ? row.signalValue.bucket : null;
      if (bucket) regimes.set(`${row.instrumentId}|${utcDateKey(row.effectiveAt)}`, bucket);
    }
    const eligibleCache = new Map<string, boolean>();
    for (const row of runtimeCache.features) {
      const asOf = utcDateKey(row.effectiveAt);
      const key = `${row.instrumentId}|${asOf}`;
      if (eligibleCache.has(key)) continue;
      const asOfDate = new Date(`${asOf}T23:59:59.999Z`);
      eligibleCache.set(key, isEligibleAt({
        asOf: asOfDate,
        memberships: membershipsByInstrument.get(row.instrumentId) ?? [],
        existence: runtimeCache.findExistenceAsOf(row.instrumentId, asOfDate),
      }).eligible);
    }
    runtimeCache.analogueSnapshots.push(...snapshotsFromFeatureRows(
      runtimeCache.features,
      regimes,
      (instrumentId, asOf) => eligibleCache.get(`${instrumentId}|${asOf}`) ?? false,
    ));
  }

  private async seedRealizedCalibration(
    runtimeCache: ReplayRuntimeCache,
    barCache: Map<string, Awaited<ReturnType<typeof loadStoredMarketBars>>>,
    seriesCutoff: Date,
  ): Promise<void> {
    const seedHorizon = async (horizon: StockIntelligenceHorizon, signals: readonly CanonicalSignal[]) => {
      for (const signal of signals) {
        const end = horizonEndUtc(signal.effectiveAt, horizon);
        if (end.getTime() > seriesCutoff.getTime()) continue;
        const cacheKey = `${signal.instrumentId}|${utcDateKey(signal.effectiveAt)}|${horizon}`;
        if (runtimeCache.realizedCalibration.has(cacheKey)) continue;
        let bars = barCache.get(signal.instrumentId);
        if (!bars) {
          bars = await loadStoredMarketBars(this.store, signal.instrumentId, seriesCutoff);
          barCache.set(signal.instrumentId, bars);
        }
        const measured = measureRealizedHorizon({
          predictionAsOf: signal.effectiveAt,
          horizon,
          evaluationCutoff: seriesCutoff,
          bars,
          actions: runtimeCache.corporateActionsAsOf(signal.instrumentId, seriesCutoff),
        });
        if (measured.status !== "REALIZED") continue;
        const observation = calibrationObservationFromSignal(signal, measured.outcome.totalReturn > 0);
        if (!observation) continue;
        runtimeCache.realizedCalibration.set(cacheKey, {
          realizableFrom: utcDateKey(end),
          observation,
        });
      }
    };
    await seedHorizon("6M", runtimeCache.outcomeSignals6m);
    await seedHorizon("12M", runtimeCache.outcomeSignals12m);
  }

  private async evaluatePair(
    jobId: string,
    pair: ReplayPair,
    seriesCutoff: Date,
    barCache: Map<string, Awaited<ReturnType<typeof loadStoredMarketBars>>>,
    persistFeatures: PersistGeneratedFeatures,
    persistAnalogues: PersistAnalogueSets,
    persistOutcomes: PredictHorizonOutcomes,
    persistSnapshots: PersistPredictionSnapshots,
    membershipsByInstrument: ReadonlyMap<string, UniverseMembership[]>,
    runtimeCache: ReplayRuntimeCache,
    indexInstrumentId: string | undefined,
    vixInstrumentId: string | undefined,
  ): Promise<ReplayPairResult> {
    const asOf = asOfCutoff(pair.asOf);
    const memberships = membershipsByInstrument.get(pair.instrumentId) ?? [];
    const existence = runtimeCache.findExistenceAsOf(pair.instrumentId, asOf);
    const eligibility = isEligibleAt({ asOf, memberships, existence });

    let bars = barCache.get(pair.instrumentId);
    if (!bars) {
      bars = await loadStoredMarketBars(this.store, pair.instrumentId, seriesCutoff);
      barCache.set(pair.instrumentId, bars);
    }

    const selected = selectBarsAsOf(bars, asOf);
    const audit = auditBarsPointInTime(selected, asOf);
    const hasFutureBars = bars.some((bar) => bar.availableAt.getTime() > asOf.getTime());
    const injection = hasFutureBars
      ? detectBarFutureInjection({ bars, cutoff: asOf })
      : { leaked: false, findings: [], protectedBarCount: selected.length, corruptedBarCount: 0, cutoff: asOf };
    const pitPassed = audit.passed && !injection.leaked;
    const completeness = marketDataCompleteness({ asOf, bars: selected });

    let fundamentalScore = 0;
    let featureCount = 0;
    let documents = 0;
    let analogueEss6m = 0;
    let analogueEss12m = 0;
    let outcomeNUsed6m = 0;
    let outcomeNUsed12m = 0;
    let rawProbabilityPositive6m: number | null = null;
    let calibratedProbabilityPositive6m: number | null = null;
    let calibrationSource6m: "regime_fit" | "global_fallback" | "none" = "none";
    // Forecast only when bars exist. Ineligible names with bars still run so their
    // features enter the analogue library (Gate 7 / PIT tests rely on that).
    const shouldForecast = pitPassed && selected.length > 0;
    if (shouldForecast) {
      let indexBars = indexInstrumentId ? barCache.get(indexInstrumentId) : undefined;
      if (indexInstrumentId && !indexBars) {
        indexBars = await loadStoredMarketBars(this.store, indexInstrumentId, seriesCutoff);
        barCache.set(indexInstrumentId, indexBars);
      }
      let vixBars = vixInstrumentId ? barCache.get(vixInstrumentId) : undefined;
      if (vixInstrumentId && !vixBars) {
        vixBars = await loadStoredMarketBars(this.store, vixInstrumentId, seriesCutoff);
        barCache.set(vixInstrumentId, vixBars);
      }
      const fundamentals = runtimeCache.fundamentalsAsOf(pair.instrumentId, asOf);
      const actions = runtimeCache.corporateActionsAsOf(pair.instrumentId, asOf);
      const facts = runtimeCache.factsAsOf(pair.instrumentId, asOf);
      const generated = await persistFeatures.execute({
        instrumentId: pair.instrumentId,
        asOf,
        bars: selected,
        indexBars,
        vixBars,
        fundamentals,
        actions,
        facts,
      });
      runtimeCache.appendFeatures(generated.featureRecords.map((record) => ({
        featureId: "cache",
        ...record,
      })));
      fundamentalScore = generated.fundamentalCompleteness;
      featureCount = generated.features.length;
      documents = generated.documentCoverage;
      const regime = indexBars && vixBars
        ? assignRegime({ asOf, niftyBars: indexBars, vixBars })
        : null;
      if (regime) {
        const signal = regimeSignal(pair.instrumentId, asOf, regime);
        await this.store.insertSignal(signal);
        runtimeCache.appendSignal(signal);
      }
      const query = snapshotFromGeneratedFeatures({
          instrumentId: pair.instrumentId,
          asOf,
          features: generated.features,
          regime,
          eligible: eligibility.eligible,
        });
      const analogues = await persistAnalogues.execute({
        instrumentId: pair.instrumentId,
        asOf,
        query,
        membershipsByInstrument,
        runtimeCache,
      });
      runtimeCache.appendAnalogueSnapshot(query);
      analogueEss6m = analogues.analogue6m.effectiveSampleSize;
      analogueEss12m = analogues.analogue12m.effectiveSampleSize;
      const outcomes = await persistOutcomes.execute({
        instrumentId: pair.instrumentId,
        asOf,
        analogue6m: analogues.analogue6m,
        analogue12m: analogues.analogue12m,
        regimeBucket: regime?.bucket ?? null,
        fundamentalCompleteness: fundamentalScore,
        barCache,
        seriesCutoff,
        runtimeCache,
      });
      outcomeNUsed6m = outcomes.forecast6m.nAnaloguesUsed;
      outcomeNUsed12m = outcomes.forecast12m.nAnaloguesUsed;
      rawProbabilityPositive6m = outcomes.forecast6m.rawProbabilityPositiveReturn;
      calibratedProbabilityPositive6m = outcomes.forecast6m.calibratedProbabilityPositiveReturn;
      calibrationSource6m = outcomes.forecast6m.calibrationSource;
      const last = selected.at(-1);
      const entryPrice = last && Number.isFinite(Number(last.close)) ? Number(last.close) : null;
      await persistSnapshots.execute({
        instrumentId: pair.instrumentId,
        asOf,
        forecast6m: outcomes.forecast6m,
        forecast12m: outcomes.forecast12m,
        analogue6m: analogues.analogue6m,
        analogue12m: analogues.analogue12m,
        dataQuality: generated.dataQuality,
        features: generated.features,
        regimeBucket: regime?.bucket ?? null,
        entryPrice,
      });
    }

    let status: ReplayPairStatus;
    if (!pitPassed) status = "PIT_VIOLATION";
    else if (!eligibility.eligible) status = "SKIPPED_INELIGIBLE";
    else if (selected.length === 0) status = "INSUFFICIENT_MARKET_DATA";
    else status = "COMPLETE";

    return {
      jobId,
      instrumentId: pair.instrumentId,
      asOf: pair.asOf,
      status,
      eligibilityReason: eligibility.reason,
      pitPassed,
      marketBarCount: selected.length,
      marketDataCompleteness: completeness,
      censorship: {
        eligibilityReason: eligibility.reason,
        pitViolationCount: audit.violations.length + injection.findings.length,
        marketBarCount: selected.length,
        marketDataCompleteness: completeness,
        fundamentalCompleteness: fundamentalScore,
        featureCount,
        documentCoverage: documents,
        analogueEffectiveSampleSize6m: analogueEss6m,
        analogueEffectiveSampleSize12m: analogueEss12m,
        outcomeNUsed6m,
        outcomeNUsed12m,
        rawProbabilityPositive6m,
        calibratedProbabilityPositive6m,
        calibrationSource6m,
      },
      pipelineVersions: currentReplayVersions(),
    };
  }
}
