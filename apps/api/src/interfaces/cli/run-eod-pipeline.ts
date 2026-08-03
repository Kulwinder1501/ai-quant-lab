import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ML_ALGORITHMS = ["xgboost", "lightgbm"];

/**
 * Walk-forward folds for the promotion gate.
 *
 * `train.py` defaults `--folds` to 1 and nothing used to pass it, so every gate
 * decision rested on a single trailing block. Measured 2026-08-03 on NIFTY50 `1d`
 * (877 labelled rows): 3 folds leaves 58 validation rows, below the gate's own
 * `--minimum-validation-rows` of 60, and the run is refused as
 * INSUFFICIENT_VALIDATION_EVIDENCE. 2 folds leaves 87 and passes. Raising this
 * further needs more rows, not a smaller floor — the floor is the thing keeping a
 * 26-row "holdout" from being reported as evidence.
 */
const WALK_FORWARD_FOLDS = "2";

/**
 * Combinatorial Purged CV block count, report-only.
 *
 * CPCV has been implemented in `validation.py` since it was written and had never
 * once been invoked. It stays out of the promotion gate deliberately — it trains on
 * later data to score earlier data, which is a fair robustness question and an unfair
 * deployment simulation — but as a diagnostic it pays for itself immediately. On the
 * directional target it showed macro-F1 beating trivial on 100% of splits while
 * accuracy *lost* on 93%, which is the signature of a model spreading predictions
 * across classes rather than knowing anything. A single-metric gate cannot see that.
 */
const CPCV_GROUPS = "6";

/**
 * The twenty research equities from migration 027, pooled into one cross-sectional
 * dataset.
 *
 * This is the only available route past the fold ceiling. NIFTY50 `1d` alone gives
 * ~875 labelled rows, which supports 2 folds before the gate's 60-row validation floor
 * bites; pooling gives 17,540 rows and 700 validation rows per fold at 5 folds.
 *
 * It is coherent only because the swing schema's features are scale-free — basis points
 * and ratios — so the model cannot simply learn which symbol it is looking at. It does
 * assume shared cross-sectional dynamics across the pool, which is a real assumption
 * and is recorded in `validationProtocol.pooledInstruments`.
 *
 * These instruments stay `is_active = FALSE`; pooling them for research does not
 * activate them for the scanner or strategy engine.
 */
const RESEARCH_EQUITY_POOL = [
  "ASIANPAINT", "AXISBANK", "BAJFINANCE", "BHARTIARTL", "HDFCBANK",
  "HINDUNILVR", "ICICIBANK", "INFY", "ITC", "KOTAKBANK",
  "LT", "MARUTI", "NESTLEIND", "RELIANCE", "SBIN",
  "SUNPHARMA", "TCS", "TITAN", "ULTRACEMCO", "WIPRO",
].join(",");

/** Viable only on the pooled dataset; 5 folds on a single instrument breaks the floor. */
const POOLED_WALK_FORWARD_FOLDS = "5";

// apps/api/{src|dist}/interfaces/cli → five levels up is the repo root. Every
// step runs a root-level npm script from there, so the pipeline behaves the
// same whether it was spawned from apps/api (host) or /app (container).
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`\n🚀 Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: "inherit", shell: true, cwd: REPO_ROOT });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const nowIso = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    // Yahoo serves roughly 60 days of 15m bars. Requesting more does not fail; it
    // silently returns less, which is how a 2.5-year request became six weeks of data.
    const sixtyDaysAgo = new Date(Date.now() - 58 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    console.info("============== EOD PIPELINE STARTED ==============");

    // 1. Fetch EOD Historical Data for NIFTY50 via Yahoo Finance (last 7 days to ensure safety)
    await runCommand("npm", [
      "run", "data:collect:historical", "--",
      "--provider", "yahoo",
      "--instrument", "NIFTY50",
      "--timeframe", "15m",
      "--from", sevenDaysAgo,
      "--to", today,
      "--skip-existing"
    ]);

    // 2. Settle matured shadow predictions against the candles just collected,
    // updating each pool model's live daily scoreboard.
    await runCommand("npm", ["run", "models:settle-predictions"]);

    // 2b. Settle matured non-directional predictions. Separate command because the two
    // label alphabets live in separate tables and grade under different rules — the
    // volatility rule compares forward and trailing range envelopes against the band
    // recorded in each model's own protocol, not a neutral band in basis points.
    // Without this the volatility models predict forever and never score, which is why
    // the only target measured to beat trivial on both metrics had no route to
    // production.
    await runCommand("npm", ["run", "models:settle-auxiliary"]);

    // 3. Train fresh candidates. Deliberately *without* --promote: a one-shot
    // holdout comparison no longer decides production. New candidates enter the
    // competition pool (step 5) and must outperform the champion on live,
    // settled outcomes before the title changes hands.
    //
    // The `15m` run below asks for history from 2024-01-01 and cannot get it: 15m is
    // Yahoo-owned and Yahoo serves roughly 60 days at that interval, so the request is
    // silently truncated to about six weeks. That, not the choice of algorithm, is why
    // these models trained on ~780 rows and scored 0.29 holdout macro-F1 against a
    // 0.333 random baseline. It is kept because the intraday prediction job consumes
    // 15m models, and its window is now stated honestly rather than implied.
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--instrument", "NIFTY50",
        "--timeframe", "15m",
        // Truthful about the provider ceiling instead of asking for 2.5 years of bars
        // that will never arrive.
        "--from", sixtyDaysAgo,
        "--to", nowIso,
        "--folds", WALK_FORWARD_FOLDS,
        "--cpcv-groups", CPCV_GROUPS,
      ]);
    }

    // 3b. Daily-timeframe candidates. `1d` is the only timeframe with multi-year
    // depth (883 NIFTY50 bars from 2023-01), so it is the only one where walk-forward
    // folds span more than one market regime. Same row count as the 15m run, vastly
    // better regime coverage.
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--instrument", "NIFTY50",
        "--timeframe", "1d",
        "--from", "2023-01-01",
        "--to", nowIso,
        "--folds", WALK_FORWARD_FOLDS,
        "--cpcv-groups", CPCV_GROUPS,
      ]);
    }

    // 3c. Volatility-regime candidates, on their own label alphabet.
    //
    // This is the one target measured to carry signal. On NIFTY50 `1d` under CPCV it
    // beat the trivial predictor on macro-F1 *and* accuracy on 100% of splits
    // (0.3982 vs 0.1595, and 0.4043 vs 0.3148), where the directional target won
    // macro-F1 alone. These models cannot reach a directional consumer: the
    // competition and settlement repositories both filter on
    // `validationProtocol.labelScheme`, so a volatility model is invisible to the
    // directional pool by construction, and may inform risk only.
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--instrument", "NIFTY50",
        "--timeframe", "1d",
        "--from", "2023-01-01",
        "--to", nowIso,
        "--label-scheme", "volatility-expansion-v1",
        "--folds", WALK_FORWARD_FOLDS,
        "--cpcv-groups", CPCV_GROUPS,
      ]);
    }

    // 3d. Pooled cross-sectional volatility candidates.
    //
    // Measured 2026-08-03, and the only configuration so far to clear the promotion
    // gate's initial baseline: 5 folds, mean macro-F1 0.4404, and under CPCV it beat
    // the trivial predictor on macro-F1 (0.4509 vs 0.1635) *and* accuracy
    // (0.4666 vs 0.3250) on 100% of splits.
    //
    // The same pooling applied to the directional target moved its CPCV macro-F1 edge
    // from +0.1038 to +0.1042 — nothing, from twenty times the data — and its accuracy
    // still lost to trivial. That is the evidence that direction's failure is the
    // target and not the sample size, so no pooled directional run is scheduled.
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--instruments", RESEARCH_EQUITY_POOL,
        "--timeframe", "1d",
        "--from", "2023-01-01",
        "--to", nowIso,
        "--label-scheme", "volatility-expansion-v1",
        "--folds", POOLED_WALK_FORWARD_FOLDS,
        "--cpcv-groups", CPCV_GROUPS,
      ]);
    }

    // 4. Shadow-predict once for the whole pool so a day with no intraday runs
    // still records at least one prediction per model (idempotent per candle).
    await runCommand("npm", ["run", "ml:predict", "--", "--competition-pool"]);

    // 4b. Shadow-predict the non-directional candidates. They are excluded from the
    // directional competition pool by design — a volatility model enrolled there once
    // sat permanently unpromotable at the top of a group it could not score in — so they
    // need their own pass or they never write a prediction and settlement (step 2b) has
    // nothing to grade. Scoped by label scheme; writes only to
    // auxiliary_model_predictions.
    await runCommand("npm", [
      "run", "ml:predict", "--",
      "--shadow-scheme", "volatility-expansion-v1",
      "--instrument", "NIFTY50",
      "--timeframe", "1d",
    ]);

    // 5. Daily competition: enroll qualifying fresh candidates, rank the pool on
    // rolling settled macro-F1, and promote the challenger only after consistent
    // live outperformance.
    await runCommand("npm", ["run", "models:compete"]);

    // 5b. Volatility competition, on settled non-directional outcomes. Its own table and
    // its own rules: the settled floor is 300 rather than the directional 60, because a
    // pooled model writes one prediction per instrument per session, so sixty rows can be
    // three sessions of twenty correlated names rather than sixty observations. A PRIMARY
    // here informs risk and regime context only.
    await runCommand("npm", ["run", "models:compete:volatility"]);

    console.info("============== EOD PIPELINE COMPLETE ==============");
  } catch (error) {
    console.error("EOD Pipeline failed:", error);
    process.exitCode = 1;
  }
}

void main();
