import { describe, expect, it } from "vitest";
import {
  EOD_INDEX_MODEL_SYMBOLS,
  EOD_ML_ALGORITHMS,
  buildEodTrainingPlan,
} from "./eod-training-plan.js";

describe("buildEodTrainingPlan", () => {
  const now = "2026-08-13T10:35:00.000Z";
  const pool = "SBIN,INFY";
  const plan = buildEodTrainingPlan(now, pool);

  it("trains NIFTY50 and BANKNIFTY independently on every production-approved scope", () => {
    for (const algorithm of EOD_ML_ALGORITHMS) {
      for (const symbol of EOD_INDEX_MODEL_SYMBOLS) {
        expect(plan.map((step) => step.description)).toEqual(expect.arrayContaining([
          `${algorithm} ${symbol} 15m directional`,
          `${algorithm} ${symbol} 1d directional`,
          `${algorithm} ${symbol} 1d volatility`,
        ]));
      }
    }
    expect(plan).toHaveLength(14);
  });

  it("keeps failed 30m/60m research configurations out of scheduled retraining", () => {
    for (const step of plan) {
      expect(step.args).not.toEqual(expect.arrayContaining(["--timeframe", "30m"]));
      expect(step.args).not.toEqual(expect.arrayContaining(["--timeframe", "60m"]));
    }
  });

  it("uses isolated model commands and preserves the common as-of cutoff", () => {
    const banknifty = plan.find((step) => step.description === "xgboost BANKNIFTY 15m directional");
    expect(banknifty?.args).toEqual(expect.arrayContaining([
      "ml:train:xgboost", "--instrument", "BANKNIFTY", "--to", now,
    ]));
    const pooled = plan.find((step) => step.description === "lightgbm pooled 1d volatility");
    expect(pooled?.args).toEqual(expect.arrayContaining([
      "--instruments", pool, "--label-scheme", "volatility-expansion-v1",
    ]));
  });
});
