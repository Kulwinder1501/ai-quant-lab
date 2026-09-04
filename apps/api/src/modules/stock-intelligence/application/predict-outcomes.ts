import type { CanonicalSignal } from "../domain/canonical.js";
import type { CanonicalMarketBar } from "../domain/adapters.js";
import type { CorporateActionRecord } from "../domain/canonical.js";
import {
  ANALOGUE_SIGNAL_12M,
  ANALOGUE_SIGNAL_6M,
  type AnalogueSet,
} from "../domain/analogue-search.js";
import {
  applyCalibration,
  fitCalibration,
  type CalibrationObservation,
} from "../domain/calibration.js";
import type { StockIntelligenceHorizon } from "../domain/data-quality.js";
import {
  OUTCOME_SIGNAL_12M,
  OUTCOME_SIGNAL_6M,
  OutcomeModel12M,
  OutcomeModel6M,
  horizonEndUtc,
  probabilityPositive,
  type HorizonForecast,
} from "../domain/outcome-model.js";
import { utcDateKey } from "../domain/returns.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import {
  STOCK_INTELLIGENCE_CALIBRATION_MODEL_VERSION,
  STOCK_INTELLIGENCE_FEATURE_VERSION,
  STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION,
} from "../domain/versions.js";
import { loadStoredMarketBars } from "./ingest-market-bars.js";
import { realizeAnalogueMembers, measureRealizedHorizon } from "./measure-realized-return.js";
import type { ReplayRuntimeCache } from "./replay-runtime-cache.js";

export function outcomeSignalName(horizon: StockIntelligenceHorizon): string {
  return horizon === "6M" ? OUTCOME_SIGNAL_6M : OUTCOME_SIGNAL_12M;
}

export function analogueSignalName(horizon: StockIntelligenceHorizon): string {
  return horizon === "6M" ? ANALOGUE_SIGNAL_6M : ANALOGUE_SIGNAL_12M;
}

export function outcomeSignal(
  instrumentId: string,
  asOf: Date,
  forecast: HorizonForecast,
  regimeBucket: string | null,
): Omit<CanonicalSignal, "signalId"> {
  return {
    instrumentId,
    signalName: outcomeSignalName(forecast.horizon),
    signalValue: {
      horizon: forecast.horizon,
      regimeBucket,
      nAnaloguesConsidered: forecast.nAnaloguesConsidered,
      nAnaloguesUsed: forecast.nAnaloguesUsed,
      nAnaloguesDroppedIncomplete: forecast.nAnaloguesDroppedIncomplete,
      nDelistedKept: forecast.nDelistedKept,
      distribution: forecast.distribution,
      scenarios: forecast.scenarios,
      rawProbabilityPositiveReturn: forecast.rawProbabilityPositiveReturn,
      calibratedProbabilityPositiveReturn: forecast.calibratedProbabilityPositiveReturn,
      calibrationSource: forecast.calibrationSource,
      status: forecast.status,
      investorFacing: forecast.investorFacing,
      calibrationModelVersion: STOCK_INTELLIGENCE_CALIBRATION_MODEL_VERSION,
    },
    strength: forecast.calibratedProbabilityPositiveReturn,
    derivedFrom: {
      nAnaloguesUsed: forecast.nAnaloguesUsed,
      calibrationSource: forecast.calibrationSource,
    },
    sourceFacts: { regimeBucket },
    featureVersion: STOCK_INTELLIGENCE_FEATURE_VERSION,
    engineVersion: STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION,
    publishedAt: asOf,
    effectiveAt: asOf,
    availableAt: asOf,
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function calibrationObservationFromSignal(
  signal: CanonicalSignal,
  actualPositive: boolean,
): CalibrationObservation | null {
  const raw = asNumber(signal.signalValue.rawProbabilityPositiveReturn);
  if (raw === null) return null;
  const regimeBucket = typeof signal.signalValue.regimeBucket === "string"
    ? signal.signalValue.regimeBucket
    : null;
  return {
    asOf: utcDateKey(signal.effectiveAt),
    instrumentId: signal.instrumentId,
    regimeBucket,
    rawProbability: raw,
    actualPositive,
  };
}

export class PredictHorizonOutcomes {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    instrumentId: string;
    asOf: Date;
    analogue6m: AnalogueSet;
    analogue12m: AnalogueSet;
    regimeBucket: string | null;
    fundamentalCompleteness: number;
    barCache: Map<string, CanonicalMarketBar[]>;
    seriesCutoff: Date;
    runtimeCache?: ReplayRuntimeCache;
  }): Promise<{ forecast6m: HorizonForecast; forecast12m: HorizonForecast }> {
    const [forecast6m, forecast12m] = await Promise.all([
      this.predictHorizon({
        ...input,
        horizon: "6M",
        analogueSet: input.analogue6m,
      }),
      this.predictHorizon({
        ...input,
        horizon: "12M",
        analogueSet: input.analogue12m,
      }),
    ]);
    const signal6m = outcomeSignal(input.instrumentId, input.asOf, forecast6m, input.regimeBucket);
    const signal12m = outcomeSignal(input.instrumentId, input.asOf, forecast12m, input.regimeBucket);
    await Promise.all([
      this.store.insertSignal(signal6m),
      this.store.insertSignal(signal12m),
    ]);
    input.runtimeCache?.appendSignal(signal6m);
    input.runtimeCache?.appendSignal(signal12m);
    return { forecast6m, forecast12m };
  }

  private async barsFor(
    instrumentId: string,
    cache: Map<string, CanonicalMarketBar[]>,
    seriesCutoff: Date,
  ): Promise<CanonicalMarketBar[]> {
    const cached = cache.get(instrumentId);
    if (cached) return cached;
    const loaded = await loadStoredMarketBars(this.store, instrumentId, seriesCutoff);
    cache.set(instrumentId, loaded);
    return loaded;
  }

  private async predictHorizon(input: {
    instrumentId: string;
    asOf: Date;
    horizon: StockIntelligenceHorizon;
    analogueSet: AnalogueSet;
    regimeBucket: string | null;
    fundamentalCompleteness: number;
    barCache: Map<string, CanonicalMarketBar[]>;
    seriesCutoff: Date;
    runtimeCache?: ReplayRuntimeCache;
  }): Promise<HorizonForecast> {
    const actionsCache = new Map<string, CorporateActionRecord[]>();
    const loadActions = async (instrumentId: string) => {
      if (input.runtimeCache) {
        return input.runtimeCache.corporateActionsAsOf(instrumentId, input.asOf);
      }
      const cached = actionsCache.get(instrumentId);
      if (cached) return cached;
      const rows = await this.store.listCorporateActionsAsOf(instrumentId, input.asOf);
      actionsCache.set(instrumentId, rows);
      return rows;
    };

    const memberIds = [...new Set(input.analogueSet.members.map((row) => row.instrumentId))];
    for (const instrumentId of memberIds) {
      await this.barsFor(instrumentId, input.barCache, input.seriesCutoff);
      await loadActions(instrumentId);
    }

    const { realized, nDroppedIncomplete } = realizeAnalogueMembers({
      members: input.analogueSet.members,
      horizon: input.horizon,
      evaluationCutoff: input.asOf,
      barsFor: (instrumentId) => input.barCache.get(instrumentId) ?? [],
      actionsFor: (instrumentId) =>
        input.runtimeCache
          ? input.runtimeCache.corporateActionsAsOf(instrumentId, input.asOf)
          : (actionsCache.get(instrumentId) ?? []),
    });

    const queryAsOfKey = utcDateKey(input.asOf);
    const prior = input.runtimeCache
      ? input.runtimeCache.signalsBefore(input.asOf, outcomeSignalName(input.horizon))
      : await this.store.listSignalsBefore(input.asOf, outcomeSignalName(input.horizon));
    const observations: CalibrationObservation[] = [];
    for (const signal of prior) {
      const cacheKey = `${signal.instrumentId}|${utcDateKey(signal.effectiveAt)}|${input.horizon}`;
      const cached = input.runtimeCache?.realizedCalibration.get(cacheKey);
      if (cached) {
        if (queryAsOfKey >= cached.realizableFrom) observations.push(cached.observation);
        continue;
      }
      const bars = await this.barsFor(signal.instrumentId, input.barCache, input.seriesCutoff);
      const actions = await loadActions(signal.instrumentId);
      const measured = measureRealizedHorizon({
        predictionAsOf: signal.effectiveAt,
        horizon: input.horizon,
        evaluationCutoff: input.asOf,
        bars,
        actions,
      });
      if (measured.status !== "REALIZED") continue;
      const observation = calibrationObservationFromSignal(signal, measured.outcome.totalReturn > 0);
      if (!observation) continue;
      input.runtimeCache?.realizedCalibration.set(cacheKey, {
        realizableFrom: utcDateKey(horizonEndUtc(signal.effectiveAt, input.horizon)),
        observation,
      });
      observations.push(observation);
    }

    const samples = realized.map((row) => ({ value: row.totalReturn, weight: row.weight }));
    const raw = samples.length === 0 ? null : probabilityPositive(samples);

    const fitted = fitCalibration({
      horizon: input.horizon,
      queryAsOf: input.asOf,
      observations,
    });
    const applied = applyCalibration({
      rawProbability: raw,
      regimeBucket: input.regimeBucket,
      fitted,
    });

    const model = input.horizon === "6M" ? new OutcomeModel6M() : new OutcomeModel12M();
    return model.predict({
      analogueSet: input.analogueSet,
      realized,
      nDroppedIncomplete,
      fundamentalCompleteness: input.fundamentalCompleteness,
      calibratedProbabilityPositiveReturn: applied.calibratedProbability,
      calibrationSource: applied.source,
    });
  }
}
