import { createHash } from "node:crypto";

export const EOD_ML_ALGORITHMS = ["xgboost", "lightgbm"] as const;

/**
 * Independently modelled tradeable indices.
 *
 * Keep this list separate from collection: a symbol being collected is not proof that its model
 * should train. Both series currently pass the persisted readiness audit on 15m and 1d.
 */
export const EOD_INDEX_MODEL_SYMBOLS = ["NIFTY50", "BANKNIFTY"] as const;

export interface EodTrainingStep {
  description: string;
  args: string[];
  /**
   * Complete identity shared by all dated refits of this configuration. Horizon, feature schema,
   * label scheme, and expansion band are included so changing any modelling assumption creates a
   * new family that trains immediately instead of inheriting an unrelated artifact's cadence.
   */
  modelFamilyKey: string;
  /** Minimum whole days between refits of this configuration. */
  cadenceDays: number;
}

const CPCV_GROUPS = "6";
// A single daily index has ~880 labelled rows. More than two folds pushes each validation
// partition below the promotion gate's 60-row evidence floor.
const SINGLE_DAILY_WALK_FORWARD_FOLDS = "2";
// The cross-sectional roster supplies enough rows to keep five folds above the same floor.
const POOLED_WALK_FORWARD_FOLDS = "5";
const VOLATILITY_LABEL_SCHEME = "volatility-expansion-v1";
const VOLATILITY_HORIZON_BARS = "5";
const VOLATILITY_EXPANSION_BAND = "0.25";
const SWING_FEATURE_SCHEMA_VERSION = "ml-feature-v7";
/**
 * Earliest bar any scheduled configuration may train on. See the window note on
 * `buildEodTrainingPlan` for why this opens at 2022 and which series it actually changes.
 */
const TRAINING_WINDOW_START = "2022-01-01";

/**
 * Minimum days between refits of one configuration.
 *
 * Every accepted refit receives a dated key. This is required because volatility shadow
 * enrollment is immutable per key: reusing a key would train another artifact that never receives
 * live predictions. The stable family key above still provides one cadence across those dated
 * challengers, avoiding nightly candidate churn and repeated holdout selection.
 *
 * Counted in calendar days rather than sessions on purpose. Sessions would need a trading
 * calendar here; the property that actually matters is that the gate measures the distance from
 * the last *artifact*, so a missed run, an outage, or a holiday stretch delays a refit instead
 * of silently forfeiting it the way a `0 0 1 * *` cron would. Thirty days is roughly twenty-one
 * sessions, on a daily series that gains one bar per session.
 */
const VOLATILITY_REFIT_CADENCE_DAYS = 30;

/**
 * Reproduce train.py's pooled instrument component: `pool{n}-{sha256(roster)[:8]}`, where the
 * roster is the members uppercased, sorted, and comma-joined.
 *
 * The sort matches because every member is ASCII: Python orders by code point and JavaScript by
 * UTF-16 code unit, which agree over `[A-Z0-9]`.
 */
function pooledInstrumentComponent(researchTrainingPool: string): string {
  const members = researchTrainingPool
    .split(",")
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol !== "");
  const roster = members.map((symbol) => symbol.toUpperCase()).sort().join(",");
  const digest = createHash("sha256").update(roster, "utf8").digest("hex").slice(0, 8);
  return `pool${members.length}-${digest}`;
}

function trainArgs(input: {
  algorithm: string;
  symbol?: string;
  instruments?: string;
  timeframe: string;
  from: string;
  to: string;
  folds: string;
  labelScheme?: string;
  horizonBars?: string;
  expansionBand?: string;
  featureSchema?: string;
  modelKey?: string;
}): string[] {
  return [
    "run", `ml:train:${input.algorithm}`, "--",
    ...(input.symbol ? ["--instrument", input.symbol] : ["--instruments", input.instruments!]),
    "--timeframe", input.timeframe,
    "--from", input.from,
    "--to", input.to,
    ...(input.labelScheme ? ["--label-scheme", input.labelScheme] : []),
    ...(input.horizonBars ? ["--horizon-bars", input.horizonBars] : []),
    ...(input.expansionBand ? ["--expansion-band", input.expansionBand] : []),
    ...(input.featureSchema ? ["--feature-schema", input.featureSchema] : []),
    ...(input.modelKey ? ["--model-key", input.modelKey] : []),
    "--folds", input.folds,
    "--cpcv-groups", CPCV_GROUPS,
  ];
}

/**
 * The production EOD training matrix.
 *
 * Every scheduled configuration targets volatility expansion. That is not a narrowing for
 * convenience — it is the only target measured to beat the trivial predictor on macro-F1 *and*
 * accuracy, and the directional target's failure has been isolated to the target itself rather
 * than to sample size: pooling moved its CPCV macro-F1 edge from +0.1038 to +0.1042, nothing
 * from twenty times the data, while its accuracy still lost to trivial. A nightly refit cannot
 * repair a target problem, so the four `1d` directional configurations are no longer scheduled.
 *
 * 30m/60m are deliberately absent for the same class of reason. Measured research found 30m/60m
 * directional prediction had no skill; the only statistically useful 60m volatility
 * configuration failed the fee-adjusted straddle gate, and BANKNIFTY was weaker still.
 *
 * ## The 15m question, answered 2026-08-13
 *
 * `15m` direction was excluded on a bad measurement for a long time: a 0.29 holdout macro-F1
 * against a 0.333 random baseline, produced on a window that asked Yahoo for 2.5 years and was
 * silently truncated to ~60 days. That cause is gone (Fyers, 2026-08-05), so the question was
 * re-run properly on the real window rather than left to an obsolete verdict.
 *
 * Six runs: xgboost and lightgbm on both indices over 2023-01-01 → 2026-08-13, five folds and six
 * CPCV groups, plus a short-window BANKNIFTY baseline before its history was backfilled to parity
 * (22,301 bars, matching NIFTY50's 22,302).
 *
 * It passes the screen that killed the `1d` directional target. Every run beat the trivial
 * predictor on macro-F1 *and* accuracy — NIFTY50 xgboost +0.1802 / +0.0209, BANKNIFTY xgboost
 * +0.1995 / +0.0508 — where `1d` direction won macro-F1 alone. That is exactly why this needed
 * measuring instead of assuming, and it is also where the good news stops.
 *
 * Three findings sink it:
 *
 * - The tradable output has no edge. `directionalHitRate` is 0.2715 on NIFTY50 and 0.3101 /
 *   0.3381 on BANKNIFTY, against a 0.3333 chance level. The macro-F1 and accuracy gains sit in
 *   the NEUTRAL class (f1 ~0.53) while BULLISH collapses (f1 0.162, recall 0.116 on NIFTY50).
 *   The model is good at predicting "no move" and no better than a coin at calling direction,
 *   and only the directional calls can be traded.
 * - It does not generalise out of era. `ml:audit`'s ERA_HOLDOUT scored 0.3177 macro-F1, at or
 *   below the 0.3333 random baseline: whatever the in-window holdout measured does not exist
 *   outside that window. Caveat, stated because it matters — that audit ran logistic at a 50bps
 *   neutral band, not the boosted families at 9bps, so it indicts the target and features on
 *   this series rather than those exact candidates.
 * - Nothing clears enrollment. All six runs returned INITIAL_BASELINE_THRESHOLD_NOT_MET, mean
 *   walk-forward macro-F1 ~0.31-0.34 against the required 0.38, so no candidate would enroll or
 *   promote even if it were scheduled.
 *
 * Two hypotheses died in the process, recorded so they are not re-run. BANKNIFTY's larger
 * accuracy edge is *not* an artifact of the 2026 volume coverage: it held at +0.0508 on the full
 * window including two volume-free years, against +0.0573 on 2025-2026 alone. And its monotonic
 * fold climb (0.250 → 0.395) *was* an artifact of thin early folds — on the full window the same
 * configuration reads [0.342, 0.364, 0.325, 0.321, 0.328], flat.
 *
 * The exclusion therefore stands on measurement rather than on the old truncation story. What
 * would reopen it is a change to the *target*, not more data or another algorithm: the failure is
 * concentrated in direction while NEUTRAL is predictable, so a configuration that trades the
 * NEUTRAL/no-move call, or a neutral band chosen per instrument rather than a fixed 9bps, is a
 * different question this result does not answer. Reproduce with:
 *
 *   npm run ml:train:xgboost -- --instrument NIFTY50 --timeframe 15m \
 *     --from 2023-01-01 --to <a past timestamp> --folds 5 --cpcv-groups 6
 *
 * `--to` must not exceed `--data-cutoff-at`, which defaults to now, so a wall-clock `nowIso`
 * refuses.
 *
 * ## Why the window opens at 2022 and not 2023
 *
 * Widened 2026-08-16, after BANKNIFTY 1d was backfilled from a series that had been empty. Only
 * one scheduled series holds pre-2023 daily bars — BANKNIFTY 1d, by 248 of its 1,145 — so this
 * is a 28% sample increase for that configuration and a no-op everywhere else: NIFTY50 1d starts
 * 2023-01-02, and no member of the pooled roster has a daily bar before 2023, so the panel stays
 * balanced rather than acquiring one member with a longer history than its peers.
 *
 * A start date earlier than the data is harmless — the query returns what exists — so this does
 * not need to be per-instrument. It matters because the daily gate is sample-starved: 888
 * labelled rows support only two walk-forward folds above the 60-row evidence floor, and on
 * 2026-08-16 BANKNIFTY lightgbm scored 0.3793 against a 0.40 threshold while its CPCV beat
 * trivial by +0.2351 on every split. The signal reads as real and under-evidenced, which is the
 * one situation where more history is the right lever.
 */
export function buildEodTrainingPlan(
  nowIso: string,
  researchTrainingPool: string,
): EodTrainingStep[] {
  const steps: EodTrainingStep[] = [];
  const pooledComponent = pooledInstrumentComponent(researchTrainingPool);
  const refitDate = nowIso.slice(0, 10).replaceAll("-", "");

  const modelFamilyKey = (algorithm: string, instrument: string): string => [
    `volatility-expansion-${algorithm}`,
    instrument,
    "1d",
    `h${VOLATILITY_HORIZON_BARS}`,
    SWING_FEATURE_SCHEMA_VERSION,
    VOLATILITY_LABEL_SCHEME,
    `band${VOLATILITY_EXPANSION_BAND}`,
  ].join("--");

  for (const algorithm of EOD_ML_ALGORITHMS) {
    for (const symbol of EOD_INDEX_MODEL_SYMBOLS) {
      const familyKey = modelFamilyKey(algorithm, symbol);
      steps.push({
        description: `${algorithm} ${symbol} 1d volatility`,
        modelFamilyKey: familyKey,
        cadenceDays: VOLATILITY_REFIT_CADENCE_DAYS,
        args: trainArgs({
          algorithm,
          symbol,
          timeframe: "1d",
          from: TRAINING_WINDOW_START,
          to: nowIso,
          folds: SINGLE_DAILY_WALK_FORWARD_FOLDS,
          labelScheme: VOLATILITY_LABEL_SCHEME,
          horizonBars: VOLATILITY_HORIZON_BARS,
          expansionBand: VOLATILITY_EXPANSION_BAND,
          featureSchema: SWING_FEATURE_SCHEMA_VERSION,
          modelKey: `${familyKey}--refit-${refitDate}`,
        }),
      });
    }

    const pooledFamilyKey = modelFamilyKey(algorithm, pooledComponent);
    steps.push({
      description: `${algorithm} pooled 1d volatility`,
      modelFamilyKey: pooledFamilyKey,
      cadenceDays: VOLATILITY_REFIT_CADENCE_DAYS,
      args: trainArgs({
        algorithm,
        instruments: researchTrainingPool,
        timeframe: "1d",
        from: TRAINING_WINDOW_START,
        to: nowIso,
        folds: POOLED_WALK_FORWARD_FOLDS,
        labelScheme: VOLATILITY_LABEL_SCHEME,
        horizonBars: VOLATILITY_HORIZON_BARS,
        expansionBand: VOLATILITY_EXPANSION_BAND,
        featureSchema: SWING_FEATURE_SCHEMA_VERSION,
        modelKey: `${pooledFamilyKey}--refit-${refitDate}`,
      }),
    });
  }

  return steps;
}

export interface SkippedTrainingStep {
  step: EodTrainingStep;
  lastTrainedAt: Date;
  daysSinceLastTrained: number;
  /**
   * The artifact that justified the skip. Logged so a wrong match is legible: if a family ever
   * starts matching a neighbouring configuration, the evidence is in the run output rather than hidden
   * behind a configuration that quietly stopped training.
   */
  matchedModelKey: string;
}

export interface DueTrainingSteps {
  due: EodTrainingStep[];
  skipped: SkippedTrainingStep[];
  degradationTriggered: Array<{ step: EodTrainingStep; matchedModelKey: string }>;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Split the matrix into configurations due by age or live-performance degradation and those still
 * inside cadence.
 *
 * Recency is read from the artifacts themselves — `MAX(trained_at)` per `model_key` — rather
 * than from a bookkeeping table the pipeline would have to keep in step. That choice decides the
 * two behaviours that matter:
 *
 * - A configuration with no matching artifact is always due. A never-trained model, a renamed
 *   key, and a changed pooled roster all read as "no artifact" and train tonight, which is the
 *   conservative direction to fail in.
 * - A refused training run leaves no artifact behind, so the data-readiness gate refusing on a
 *   NOT READY series does not consume the month. The configuration is retried the next evening.
 * - A current volatility PRIMARY with sufficient live evidence that no longer beats the trivial
 *   majority-class predictor bypasses cadence once, so performance decay does not wait a month.
 */
export function selectDueTrainingSteps(
  steps: readonly EodTrainingStep[],
  latestTrainedAtByModelKey: ReadonlyMap<string, Date>,
  now: Date,
  degradedModelKeys: ReadonlySet<string> = new Set(),
): DueTrainingSteps {
  const due: EodTrainingStep[] = [];
  const skipped: SkippedTrainingStep[] = [];
  const degradationTriggered: Array<{ step: EodTrainingStep; matchedModelKey: string }> = [];

  for (const step of steps) {
    let lastTrainedAt: Date | null = null;
    let matchedModelKey = "";
    for (const [modelKey, trainedAt] of latestTrainedAtByModelKey) {
      const belongsToFamily = modelKey === step.modelFamilyKey
        || modelKey.startsWith(`${step.modelFamilyKey}--refit-`);
      if (!belongsToFamily) continue;
      if (lastTrainedAt === null || trainedAt > lastTrainedAt) {
        lastTrainedAt = trainedAt;
        matchedModelKey = modelKey;
      }
    }

    if (lastTrainedAt === null) {
      due.push(step);
      continue;
    }

    if (degradedModelKeys.has(matchedModelKey)) {
      due.push(step);
      degradationTriggered.push({ step, matchedModelKey });
      continue;
    }

    const daysSinceLastTrained = (now.getTime() - lastTrainedAt.getTime()) / MILLISECONDS_PER_DAY;
    // A clock skew or a backdated artifact must not park a configuration indefinitely, so a
    // negative age counts as due rather than as "trained in the future".
    if (daysSinceLastTrained >= step.cadenceDays || daysSinceLastTrained < 0) {
      due.push(step);
      continue;
    }
    skipped.push({ step, lastTrainedAt, daysSinceLastTrained, matchedModelKey });
  }

  return { due, skipped, degradationTriggered };
}
