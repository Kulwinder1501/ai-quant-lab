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
}

const CPCV_GROUPS = "6";
// A single daily index has ~880 labelled rows. More than two folds pushes each validation
// partition below the promotion gate's 60-row evidence floor.
const SINGLE_DAILY_WALK_FORWARD_FOLDS = "2";
// Both 15m index series have enough depth for five forward windows spanning multiple regimes.
const DEEP_INTRADAY_WALK_FORWARD_FOLDS = "5";
// The cross-sectional roster supplies enough rows to keep five folds above the same floor.
const POOLED_WALK_FORWARD_FOLDS = "5";

function trainArgs(input: {
  algorithm: string;
  symbol?: string;
  instruments?: string;
  timeframe: string;
  from: string;
  to: string;
  folds: string;
  labelScheme?: string;
}): string[] {
  return [
    "run", `ml:train:${input.algorithm}`, "--",
    ...(input.symbol ? ["--instrument", input.symbol] : ["--instruments", input.instruments!]),
    "--timeframe", input.timeframe,
    "--from", input.from,
    "--to", input.to,
    ...(input.labelScheme ? ["--label-scheme", input.labelScheme] : []),
    "--folds", input.folds,
    "--cpcv-groups", CPCV_GROUPS,
  ];
}

/**
 * The production EOD training matrix.
 *
 * 30m/60m are deliberately absent. Measured research found 30m/60m directional prediction had
 * no skill; the only statistically useful 60m volatility configuration failed the fee-adjusted
 * straddle gate, and BANKNIFTY was weaker still. Those remain manually runnable research
 * experiments, not candidates recreated every evening.
 */
export function buildEodTrainingPlan(
  nowIso: string,
  researchTrainingPool: string,
): EodTrainingStep[] {
  const steps: EodTrainingStep[] = [];

  for (const algorithm of EOD_ML_ALGORITHMS) {
    for (const symbol of EOD_INDEX_MODEL_SYMBOLS) {
      steps.push({
        description: `${algorithm} ${symbol} 15m directional`,
        args: trainArgs({
          algorithm,
          symbol,
          timeframe: "15m",
          from: "2023-01-01",
          to: nowIso,
          folds: DEEP_INTRADAY_WALK_FORWARD_FOLDS,
        }),
      });
      steps.push({
        description: `${algorithm} ${symbol} 1d directional`,
        args: trainArgs({
          algorithm,
          symbol,
          timeframe: "1d",
          from: "2023-01-01",
          to: nowIso,
          folds: SINGLE_DAILY_WALK_FORWARD_FOLDS,
        }),
      });
      steps.push({
        description: `${algorithm} ${symbol} 1d volatility`,
        args: trainArgs({
          algorithm,
          symbol,
          timeframe: "1d",
          from: "2023-01-01",
          to: nowIso,
          folds: SINGLE_DAILY_WALK_FORWARD_FOLDS,
          labelScheme: "volatility-expansion-v1",
        }),
      });
    }

    steps.push({
      description: `${algorithm} pooled 1d volatility`,
      args: trainArgs({
        algorithm,
        instruments: researchTrainingPool,
        timeframe: "1d",
        from: "2023-01-01",
        to: nowIso,
        folds: POOLED_WALK_FORWARD_FOLDS,
        labelScheme: "volatility-expansion-v1",
      }),
    });
  }

  return steps;
}
