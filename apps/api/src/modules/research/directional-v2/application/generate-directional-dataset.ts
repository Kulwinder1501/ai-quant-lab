import type { SessionCandle, MarketSession } from "../domain/session-calendar.js";
import { groupCandlesBySession } from "../domain/session-calendar.js";
import { buildDecisionGridForSession, type DecisionPoint } from "../domain/decision-grid.js";
import {
  RobustAbsEwmaVolatilityEstimator,
  ExpandingTodProfileBuilder,
  type VolatilityContext,
} from "../domain/ex-ante-volatility.js";
import { buildForwardPathForDecision, type ForwardPath } from "../domain/forward-path.js";
import {
  labelAdaptiveFixedHorizon,
  labelTripleBarrier,
  labelPathEfficiency,
  labelContinuousReturn,
  labelMoveThenSide,
  type AdaptiveLabelOutcome,
  type TripleBarrierOutcome,
  type PathEfficiencyOutcome,
  type ContinuousReturnOutcome,
  type MoveThenSideOutcome,
} from "../domain/label-families.js";
import {
  computeConcurrencyAndUniqueness,
  type OverlapSummary,
  type SampleUniqueness,
} from "../domain/concurrency-uniqueness.js";

/**
 * Directional Dataset Sample carrying all canonical outcomes, labels, and uniqueness metadata.
 */
export interface DirectionalSample {
  readonly sampleId: string;
  readonly instrument: string;
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly minuteOfDay: number;
  readonly timeToSessionCloseMinutes: number;
  readonly referencePrice: number;
  readonly volatility: VolatilityContext;
  readonly forwardPath: ForwardPath;

  // Horizon-specific labels
  readonly adaptive15?: AdaptiveLabelOutcome;
  readonly adaptive30?: AdaptiveLabelOutcome;
  readonly adaptive60?: AdaptiveLabelOutcome;

  readonly tb15?: TripleBarrierOutcome;
  readonly tb30?: TripleBarrierOutcome;
  readonly tb60?: TripleBarrierOutcome;

  readonly pathEff15?: PathEfficiencyOutcome;
  readonly pathEff30?: PathEfficiencyOutcome;
  readonly pathEff60?: PathEfficiencyOutcome;

  readonly continuous15?: ContinuousReturnOutcome;
  readonly continuous30?: ContinuousReturnOutcome;
  readonly continuous60?: ContinuousReturnOutcome;

  readonly moveSide15?: MoveThenSideOutcome;
  readonly moveSide30?: MoveThenSideOutcome;
  readonly moveSide60?: MoveThenSideOutcome;
}

export interface DirectionalDataset {
  readonly instrument: string;
  readonly samples: readonly DirectionalSample[];
  readonly sessions: readonly MarketSession[];
  readonly overlapByHorizon: ReadonlyMap<15 | 30 | 60, OverlapSummary>;
  readonly overlapByTarget: ReadonlyMap<string, OverlapSummary>;
  readonly uniquenessBySampleId: ReadonlyMap<string, SampleUniqueness>;
}

export interface DatasetGeneratorOptions {
  readonly kMultiplier?: number; // default 0.5
  readonly tbMultiplier?: number; // default 1.0
  readonly gridIntervalMinutes?: number; // default 5m
  readonly marketSessions?: readonly MarketSession[];
}

/**
 * Builds the complete Directional Intelligence V2 Dataset for an instrument from audited 1m candles.
 */
export function generateDirectionalDataset(
  instrument: string,
  candles: readonly SessionCandle[],
  options: DatasetGeneratorOptions = {},
): DirectionalDataset {
  const kMultiplier = options.kMultiplier ?? 0.5;
  const tbMultiplier = options.tbMultiplier ?? 1.0;

  // 1. Group candles by session
  const sessionMap = groupCandlesBySession(candles, options.marketSessions);
  const sortedDates = Array.from(sessionMap.keys()).sort();

  const sessions: MarketSession[] = [];

  for (const dateStr of sortedDates) {
    const entry = sessionMap.get(dateStr)!;
    sessions.push(entry.session);
  }

  const volEstimator = new RobustAbsEwmaVolatilityEstimator(15.0, 0.94);
  const todProfileBuilder = new ExpandingTodProfileBuilder();
  const rawSamples: DirectionalSample[] = [];

  // 2. Iterate through sessions chronologically
  for (let sIdx = 0; sIdx < sortedDates.length; sIdx += 1) {
    const dateStr = sortedDates[sIdx]!;
    const { session, candles: sessionCandles } = sessionMap.get(dateStr)!;

    // Expanding TOD profile strictly up to this date (no future data)
    const todProfile = todProfileBuilder.snapshot(dateStr);

    // Build 5m decision grid
    const decisionGrid = buildDecisionGridForSession(instrument, session, sessionCandles, {
      gridIntervalMinutes: options.gridIntervalMinutes ?? 5,
    });

    let processedCandleCount = 1;
    for (const decision of decisionGrid) {
      // Advance the expanding EWMA through every newly observable intraday return.
      // This is done before estimating the decision threshold and never crosses sessions.
      while (processedCandleCount < decision.trailingSessionCandles.length) {
        const current = decision.trailingSessionCandles[processedCandleCount]!;
        const previous = decision.trailingSessionCandles[processedCandleCount - 1]!;
        if (previous.close > 0 && current.close > 0) {
          volEstimator.update(10_000 * Math.log(current.close / previous.close));
        }
        processedCandleCount += 1;
      }
      // Ex-ante volatility estimate for this decision
      const volContext = volEstimator.estimateForDecision(decision, todProfile);

      // Canonical forward path from future candles in this session
      const forwardPath = buildForwardPathForDecision(decision, sessionCandles);

      // Generate labels for available horizons
      let adaptive15: AdaptiveLabelOutcome | undefined;
      let adaptive30: AdaptiveLabelOutcome | undefined;
      let adaptive60: AdaptiveLabelOutcome | undefined;

      let tb15: TripleBarrierOutcome | undefined;
      let tb30: TripleBarrierOutcome | undefined;
      let tb60: TripleBarrierOutcome | undefined;

      let pathEff15: PathEfficiencyOutcome | undefined;
      let pathEff30: PathEfficiencyOutcome | undefined;
      let pathEff60: PathEfficiencyOutcome | undefined;

      let continuous15: ContinuousReturnOutcome | undefined;
      let continuous30: ContinuousReturnOutcome | undefined;
      let continuous60: ContinuousReturnOutcome | undefined;

      let moveSide15: MoveThenSideOutcome | undefined;
      let moveSide30: MoveThenSideOutcome | undefined;
      let moveSide60: MoveThenSideOutcome | undefined;

      if (forwardPath.horizon15) {
        adaptive15 = labelAdaptiveFixedHorizon(forwardPath.horizon15, volContext.expectedVol15mBps, kMultiplier);
        tb15 = labelTripleBarrier(forwardPath, forwardPath.horizon15, volContext.expectedVol15mBps, tbMultiplier);
        pathEff15 = labelPathEfficiency(forwardPath, forwardPath.horizon15);
        continuous15 = labelContinuousReturn(forwardPath.horizon15, volContext.expectedVol15mBps);
        moveSide15 = labelMoveThenSide(forwardPath.horizon15, volContext.expectedVol15mBps, kMultiplier);
      }

      if (forwardPath.horizon30) {
        adaptive30 = labelAdaptiveFixedHorizon(forwardPath.horizon30, volContext.expectedVol30mBps, kMultiplier);
        tb30 = labelTripleBarrier(forwardPath, forwardPath.horizon30, volContext.expectedVol30mBps, tbMultiplier);
        pathEff30 = labelPathEfficiency(forwardPath, forwardPath.horizon30);
        continuous30 = labelContinuousReturn(forwardPath.horizon30, volContext.expectedVol30mBps);
        moveSide30 = labelMoveThenSide(forwardPath.horizon30, volContext.expectedVol30mBps, kMultiplier);
      }

      if (forwardPath.horizon60) {
        adaptive60 = labelAdaptiveFixedHorizon(forwardPath.horizon60, volContext.expectedVol60mBps, kMultiplier);
        tb60 = labelTripleBarrier(forwardPath, forwardPath.horizon60, volContext.expectedVol60mBps, tbMultiplier);
        pathEff60 = labelPathEfficiency(forwardPath, forwardPath.horizon60);
        continuous60 = labelContinuousReturn(forwardPath.horizon60, volContext.expectedVol60mBps);
        moveSide60 = labelMoveThenSide(forwardPath.horizon60, volContext.expectedVol60mBps, kMultiplier);
      }

      rawSamples.push({
        sampleId: decision.sampleId,
        instrument,
        sessionDate: dateStr,
        decisionAt: decision.decisionAt,
        dataThrough: decision.dataThrough,
        minuteOfDay: decision.minuteOfDay,
        timeToSessionCloseMinutes: decision.timeToSessionCloseMinutes,
        referencePrice: decision.referenceCandle.close,
        volatility: volContext,
        forwardPath,
        adaptive15,
        adaptive30,
        adaptive60,
        tb15,
        tb30,
        tb60,
        pathEff15,
        pathEff30,
        pathEff60,
        continuous15,
        continuous30,
        continuous60,
        moveSide15,
        moveSide30,
        moveSide60,
      });
    }

    // Consume returns after the final decision so the next session starts from all prior information.
    for (let c = processedCandleCount; c < sessionCandles.length; c += 1) {
      const cur = sessionCandles[c]!;
      const prev = sessionCandles[c - 1]!;
      if (prev.close > 0 && cur.close > 0) {
        const retBps = 10_000 * Math.log(cur.close / prev.close);
        volEstimator.update(retBps);
      }
    }
    todProfileBuilder.addSession(sessionCandles);
  }

  // 3. Calculate target-specific concurrency and uniqueness per horizon
  const overlapByHorizon = new Map<15 | 30 | 60, OverlapSummary>();
  const overlapByTarget = new Map<string, OverlapSummary>();
  const uniquenessBySampleId = new Map<string, SampleUniqueness>();

  for (const horizon of [15, 30, 60] as const) {
    const key = `adaptive${horizon}` as const;
    const intervalSamples = rawSamples
      .filter((s) => s[key] !== undefined)
      .map((s) => ({
        sampleId: `${s.sampleId}--h${horizon}`,
        labelStartAt: s[key]!.labelStartAt,
        labelEndAt: s[key]!.labelEndAt,
      }));

    const result = computeConcurrencyAndUniqueness(intervalSamples);
    overlapByHorizon.set(horizon, result.summary);
    overlapByTarget.set(`D0-A--h${horizon}`, result.summary);

    for (const u of result.samplesWithUniqueness) {
      uniquenessBySampleId.set(u.sampleId, u);
    }

    const targetKeys = [
      { family: "D0-B", key: `tb${horizon}` as const },
      { family: "D0-C", key: `pathEff${horizon}` as const },
      { family: "D0-D", key: `continuous${horizon}` as const },
      { family: "D0-E", key: `moveSide${horizon}` as const },
    ];
    for (const target of targetKeys) {
      const targetIntervals = rawSamples
        .filter((sample) => sample[target.key] !== undefined)
        .map((sample) => ({
          sampleId: `${sample.sampleId}--${target.family}--h${horizon}`,
          labelStartAt: sample[target.key]!.labelStartAt,
          labelEndAt: sample[target.key]!.labelEndAt,
        }));
      const targetResult = computeConcurrencyAndUniqueness(targetIntervals);
      overlapByTarget.set(`${target.family}--h${horizon}`, targetResult.summary);
      for (const uniqueness of targetResult.samplesWithUniqueness) {
        uniquenessBySampleId.set(uniqueness.sampleId, uniqueness);
      }
    }
  }

  return {
    instrument,
    samples: rawSamples,
    sessions,
    overlapByHorizon,
    overlapByTarget,
    uniquenessBySampleId,
  };
}
