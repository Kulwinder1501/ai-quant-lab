import type { CanonicalMarketBar } from "../domain/adapters.js";
import type { StockIntelligenceHorizon } from "../domain/data-quality.js";
import {
  DEFAULT_CENSORED_BIAS_ASSESSMENT,
  evaluateGate7,
  type Gate7ForecastRow,
  type Gate7Report,
} from "../domain/gate7.js";
import { horizonHasCompleted, type ReturnDistribution } from "../domain/outcome-model.js";
import { outcomeSignalName } from "./predict-outcomes.js";
import { measureRealizedHorizon } from "./measure-realized-return.js";
import { loadStoredMarketBars } from "./ingest-market-bars.js";
import { summarizeReplayResults } from "../domain/replay.js";
import { utcDateKey } from "../domain/returns.js";
import type { StockIntelligenceStore } from "../domain/store.js";

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asDistribution(value: unknown): ReturnDistribution | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const keys = ["p10", "p25", "p50", "p75", "p90"] as const;
  if (!keys.every((key) => typeof row[key] === "number")) return null;
  return {
    p10: row.p10 as number,
    p25: row.p25 as number,
    p50: row.p50 as number,
    p75: row.p75 as number,
    p90: row.p90 as number,
  };
}

export class EvaluateGate7 {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    jobId: string;
    evaluationAsOf: Date;
    horizon?: StockIntelligenceHorizon;
  }): Promise<Gate7Report> {
    const horizon = input.horizon ?? "6M";
    const job = await this.store.getReplayJob(input.jobId);
    if (!job) throw new Error(`Replay job ${input.jobId} was not found.`);
    const results = await this.store.listReplayPairResults(input.jobId);
    const censorship = summarizeReplayResults(job, results);
    const barCache = new Map<string, readonly CanonicalMarketBar[]>();
    const forecasts: Gate7ForecastRow[] = [];

    for (const result of results) {
      if (result.status !== "COMPLETE") continue;
      const asOf = new Date(`${result.asOf}T23:59:59.999Z`);
      const signals = await this.store.listSignalsAsOf(result.instrumentId, asOf);
      const outcome = signals.find((row) => row.signalName === outcomeSignalName(horizon)
        && utcDateKey(row.effectiveAt) === result.asOf);
      if (!outcome) continue;

      let actualTotalReturn: number | null = null;
      if (horizonHasCompleted(asOf, horizon, input.evaluationAsOf)) {
        let bars = barCache.get(result.instrumentId);
        if (!bars) {
          bars = await loadStoredMarketBars(this.store, result.instrumentId, input.evaluationAsOf);
          barCache.set(result.instrumentId, bars);
        }
        const actions = await this.store.listCorporateActionsAsOf(result.instrumentId, input.evaluationAsOf);
        const measured = measureRealizedHorizon({
          predictionAsOf: asOf,
          horizon,
          evaluationCutoff: input.evaluationAsOf,
          bars,
          actions,
        });
        if (measured.status === "REALIZED") actualTotalReturn = measured.outcome.totalReturn;
      }

      forecasts.push({
        instrumentId: result.instrumentId,
        asOf: result.asOf,
        horizon,
        pairStatus: result.status,
        regimeBucket: typeof outcome.signalValue.regimeBucket === "string" ? outcome.signalValue.regimeBucket : null,
        investorFacing: outcome.signalValue.investorFacing === true,
        rawProbability: asNumber(outcome.signalValue.rawProbabilityPositiveReturn),
        calibratedProbability: asNumber(outcome.signalValue.calibratedProbabilityPositiveReturn),
        distribution: asDistribution(outcome.signalValue.distribution),
        actualTotalReturn,
        sameDateEligibleMedian: null,
        sectorStable: false,
      });
    }

    const medians = new Map<string, number>();
    const byDate = new Map<string, number[]>();
    for (const row of forecasts) {
      if (row.actualTotalReturn === null) continue;
      const current = byDate.get(row.asOf) ?? [];
      current.push(row.actualTotalReturn);
      byDate.set(row.asOf, current);
    }
    for (const [asOf, values] of byDate) {
      const sorted = [...values].sort((a, b) => a - b);
      medians.set(asOf, sorted[Math.floor(sorted.length / 2)]!);
    }

    const withMedians = forecasts.map((row) => ({
      ...row,
      sameDateEligibleMedian: medians.get(row.asOf) ?? null,
    }));

    return evaluateGate7({
      evaluationAsOf: utcDateKey(input.evaluationAsOf),
      censorship,
      forecasts: withMedians,
      censoredBiasAssessment: DEFAULT_CENSORED_BIAS_ASSESSMENT,
      horizon,
      pipelineVersions: job.pipelineVersions,
    });
  }
}
