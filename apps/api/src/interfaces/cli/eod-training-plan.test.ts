import { describe, expect, it } from "vitest";
import {
  EOD_INDEX_MODEL_SYMBOLS,
  EOD_ML_ALGORITHMS,
  buildEodTrainingPlan,
  selectDueTrainingSteps,
} from "./eod-training-plan.js";

describe("buildEodTrainingPlan", () => {
  const now = "2026-08-13T10:35:00.000Z";
  const pool = "SBIN,INFY";
  const plan = buildEodTrainingPlan(now, pool);

  it("trains NIFTY50 and BANKNIFTY independently on every production-approved scope", () => {
    for (const algorithm of EOD_ML_ALGORITHMS) {
      for (const symbol of EOD_INDEX_MODEL_SYMBOLS) {
        expect(plan.map((step) => step.description)).toEqual(expect.arrayContaining([
          `${algorithm} ${symbol} 1d volatility`,
        ]));
      }
      expect(plan.map((step) => step.description)).toContain(`${algorithm} pooled 1d volatility`);
    }
    expect(plan).toHaveLength(6);
  });

  it("schedules the volatility target only, because it is the one measured to beat trivial", () => {
    for (const step of plan) {
      expect(step.args).toEqual(expect.arrayContaining([
        "--label-scheme", "volatility-expansion-v1",
        "--horizon-bars", "5",
        "--expansion-band", "0.25",
        "--feature-schema", "ml-feature-v7",
      ]));
    }
  });

  it("keeps failed 30m/60m and unresolved 15m configurations out of scheduled retraining", () => {
    for (const step of plan) {
      expect(step.args).not.toEqual(expect.arrayContaining(["--timeframe", "30m"]));
      expect(step.args).not.toEqual(expect.arrayContaining(["--timeframe", "60m"]));
      expect(step.args).not.toEqual(expect.arrayContaining(["--timeframe", "15m"]));
    }
  });

  it("uses isolated model commands and preserves the common as-of cutoff", () => {
    const banknifty = plan.find((step) => step.description === "xgboost BANKNIFTY 1d volatility");
    expect(banknifty?.args).toEqual(expect.arrayContaining([
      "ml:train:xgboost", "--instrument", "BANKNIFTY", "--to", now,
    ]));
    const pooled = plan.find((step) => step.description === "lightgbm pooled 1d volatility");
    expect(pooled?.args).toEqual(expect.arrayContaining([
      "--instruments", pool, "--label-scheme", "volatility-expansion-v1",
    ]));
  });

  it("derives complete family keys and dated refit keys that match train.py's identity", () => {
    const nifty = plan.find((step) => step.description === "xgboost NIFTY50 1d volatility");
    expect(nifty?.modelFamilyKey).toBe(
      "volatility-expansion-xgboost--NIFTY50--1d--h5--ml-feature-v7--volatility-expansion-v1--band0.25",
    );
    expect(nifty?.args).toEqual(expect.arrayContaining([
      "--model-key",
      `${nifty!.modelFamilyKey}--refit-20260813`,
    ]));
    // Ground truth from train.py's own hash: sha256("INFY,SBIN")[:8] via hashlib is 71ffbbe3.
    // Hardcoded rather than recomputed with the same helper, so this asserts the TypeScript
    // mirror still agrees with the Python implementation instead of agreeing with itself.
    const pooled = plan.find((step) => step.description === "xgboost pooled 1d volatility");
    expect(pooled?.modelFamilyKey).toBe(
      "volatility-expansion-xgboost--pool2-71ffbbe3--1d--h5--ml-feature-v7--volatility-expansion-v1--band0.25",
    );
  });

  it("opens every scheduled window at 2022, so the one series with earlier bars can use them", () => {
    // Widened from 2023-01-01 once BANKNIFTY 1d was backfilled. Only that series holds pre-2023
    // daily bars, so this is a 28% sample increase there and a no-op elsewhere — a start date
    // earlier than the data returns what exists.
    for (const step of plan) {
      expect(step.args).toEqual(expect.arrayContaining(["--from", "2022-01-01"]));
    }
  });

  it("distinguishes rosters of equal length, so a member swap is a configuration with no artifact", () => {
    const swapped = buildEodTrainingPlan(now, "SBIN,TCS")
      .find((step) => step.description === "xgboost pooled 1d volatility");
    expect(swapped?.modelFamilyKey).toBe(
      "volatility-expansion-xgboost--pool2-b43a9abb--1d--h5--ml-feature-v7--volatility-expansion-v1--band0.25",
    );
  });

  it("hashes the roster order-insensitively, matching train.py's sorted member list", () => {
    const reordered = buildEodTrainingPlan(now, "INFY,SBIN")
      .find((step) => step.description === "xgboost pooled 1d volatility");
    const original = plan.find((step) => step.description === "xgboost pooled 1d volatility");
    expect(reordered?.modelFamilyKey).toBe(original?.modelFamilyKey);
  });
});

describe("selectDueTrainingSteps", () => {
  const now = "2026-08-13T10:35:00.000Z";
  const plan = buildEodTrainingPlan(now, "SBIN,INFY");
  const niftyXgboost = plan.find((step) => step.description === "xgboost NIFTY50 1d volatility")!;
  const niftyKey = niftyXgboost.modelFamilyKey;

  it("treats a configuration with no artifact as due", () => {
    const { due, skipped } = selectDueTrainingSteps([niftyXgboost], new Map(), new Date(now));
    expect(due).toEqual([niftyXgboost]);
    expect(skipped).toEqual([]);
  });

  it("treats every configuration as due when recency is unavailable", () => {
    const { due } = selectDueTrainingSteps(plan, new Map(), new Date(now));
    expect(due).toHaveLength(plan.length);
  });

  it("holds a configuration refitted inside its cadence", () => {
    const trainedAt = new Date("2026-08-01T10:35:00.000Z");
    const { due, skipped } = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([[`${niftyKey}--refit-20260801`, trainedAt]]),
      new Date(now),
    );
    expect(due).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.lastTrainedAt).toEqual(trainedAt);
    expect(skipped[0]?.daysSinceLastTrained).toBeCloseTo(12, 5);
    expect(skipped[0]?.matchedModelKey).toBe(`${niftyKey}--refit-20260801`);
  });

  it("releases a configuration once its cadence has elapsed", () => {
    const { due, skipped } = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([[`${niftyKey}--refit-20260714`, new Date("2026-07-14T10:35:00.000Z")]]),
      new Date(now),
    );
    expect(due).toEqual([niftyXgboost]);
    expect(skipped).toEqual([]);
  });

  it("does not let a backdated clock park a configuration forever", () => {
    const { due } = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([[`${niftyKey}--refit-20260930`, new Date("2026-09-30T10:35:00.000Z")]]),
      new Date(now),
    );
    expect(due).toEqual([niftyXgboost]);
  });

  it("never counts another family's artifact as this configuration's refit", () => {
    // Instrument, timeframe, target, algorithm, horizon, schema, and band are all identity.
    const otherFamilies = new Map([
      ["volatility-expansion-xgboost--BANKNIFTY--1d--h5--ml-feature-v7--volatility-expansion-v1--band0.25", new Date(now)],
      ["volatility-expansion-xgboost--NIFTY50--15m--h5--ml-feature-v7--volatility-expansion-v1--band0.25", new Date(now)],
      ["market-direction-xgboost--NIFTY50--1d--h5--ml-feature-v7--neutral-10bps", new Date(now)],
      ["volatility-expansion-lightgbm--NIFTY50--1d--h5--ml-feature-v7--volatility-expansion-v1--band0.25", new Date(now)],
      ["volatility-expansion-xgboost--NIFTY50--1d--h4--ml-feature-v7--volatility-expansion-v1--band0.25", new Date(now)],
      ["volatility-expansion-xgboost--NIFTY50--1d--h5--ml-feature-v6--volatility-expansion-v1--band0.25", new Date(now)],
      ["volatility-expansion-xgboost--NIFTY50--1d--h5--ml-feature-v7--volatility-expansion-v1--band1.5", new Date(now)],
    ]);
    const { due } = selectDueTrainingSteps([niftyXgboost], otherFamilies, new Date(now));
    expect(due).toEqual([niftyXgboost]);
  });

  it("takes the newest artifact when a configuration has several", () => {
    const newestKey = `${niftyKey}--refit-20260811`;
    const { skipped } = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([
        [niftyKey, new Date("2026-01-01T10:35:00.000Z")],
        [newestKey, new Date("2026-08-11T10:35:00.000Z")],
      ]),
      new Date(now),
    );
    expect(skipped[0]?.daysSinceLastTrained).toBeCloseTo(2, 5);
    expect(skipped[0]?.matchedModelKey).toBe(newestKey);
  });

  it("does not let an old expansion band delay the current configuration", () => {
    const oldBand = niftyKey.replace("band0.25", "band1.5");
    const { due } = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([[oldBand, new Date(now)]]),
      new Date(now),
    );
    expect(due).toEqual([niftyXgboost]);
  });

  it("bypasses cadence when the newest artifact has degraded live performance", () => {
    const currentKey = `${niftyKey}--refit-20260801`;
    const result = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([[currentKey, new Date("2026-08-01T10:35:00.000Z")]]),
      new Date(now),
      new Set([currentKey]),
    );
    expect(result.due).toEqual([niftyXgboost]);
    expect(result.skipped).toEqual([]);
    expect(result.degradationTriggered).toEqual([{ step: niftyXgboost, matchedModelKey: currentKey }]);
  });

  it("does not retrigger from an older degraded artifact after a newer refit", () => {
    const oldKey = `${niftyKey}--refit-20260701`;
    const currentKey = `${niftyKey}--refit-20260801`;
    const result = selectDueTrainingSteps(
      [niftyXgboost],
      new Map([
        [oldKey, new Date("2026-07-01T10:35:00.000Z")],
        [currentKey, new Date("2026-08-01T10:35:00.000Z")],
      ]),
      new Date(now),
      new Set([oldKey]),
    );
    expect(result.due).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.degradationTriggered).toEqual([]);
  });
});
