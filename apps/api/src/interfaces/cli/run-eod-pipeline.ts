import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresModelTrainingRecencyRepository } from "../../infrastructure/database/repositories/postgres-model-training-recency-repository.js";
import { buildEodTrainingPlan, selectDueTrainingSteps } from "./eod-training-plan.js";

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
  "SUNPHARMA", "TCS", "TITAN", "ULTRACEMCO", "WIPRO"
];

// Yahoo does not expose these canonical index keys as ordinary NSE equities.
// They are collected through the same Fyers index mapping used intraday instead
// of falling through to invalid `FINNIFTY.NS`-style tickers.
const RESEARCH_INDEX_POOL = [
  "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50",
];

const RESEARCH_TRAINING_POOL = [
  ...RESEARCH_EQUITY_POOL,
  ...RESEARCH_INDEX_POOL,
].join(",");

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

/**
 * Read model recency and live degradation state, holding a connection only for those queries.
 *
 * The pool is opened and closed around the read rather than for the pipeline's lifetime: the
 * training steps that follow are measured in hours, and a pool parked open across them would
 * hold a connection idle through the longest phase of the run for a single `GROUP BY`.
 */
async function loadModelTrainingState(): Promise<{
  latestTrainedAt: ReadonlyMap<string, Date>;
  degradedModelKeys: ReadonlySet<string>;
}> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const repository = new PostgresModelTrainingRecencyRepository(database);
    const [latestTrainedAt, degradedModelKeys] = await Promise.all([
      repository.getLatestTrainedAtByModelKey(),
      repository.getDegradedVolatilityModelKeys(),
    ]);
    return { latestTrainedAt, degradedModelKeys };
  } finally {
    await database.end();
  }
}

const trainingFailures: string[] = [];

/**
 * Training steps are isolated: a refused or failed training run must not stop
 * settlement, shadow prediction, or the competitions that follow it. The
 * data-readiness gate in `train.py` refuses with a non-zero exit when a series
 * is not READY — that refusal is the gate working, and the correct pipeline
 * response is to record it loudly, skip that candidate, and keep grading the
 * models that already exist. The pipeline still exits non-zero at the end when
 * any training step failed, so the failure is never silent.
 */
async function runTrainingStep(description: string, args: string[]): Promise<void> {
  try {
    await runCommand("npm", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trainingFailures.push(`${description}: ${message}`);
    console.error(`\n⚠️ Training step failed and was skipped — ${description}: ${message}`);
  }
}

const collectionFailures: string[] = [];

/**
 * Collection steps are isolated for the same reason training steps are, and the omission was
 * expensive. This pipeline failed all four of its runs in the week to 2026-08-16, and two of
 * them died here at step 1: `Completed candles are immutable` on 2026-08-10, and
 * `The BANKNIFTY 1d series is declared as yahoo, not fyers` on 2026-08-13.
 *
 * Neither is a reason to skip settlement, but that is what happened — the process aborted
 * before `models:settle-auxiliary` ran, so nothing was graded on either day. The volatility
 * competition needs 15 scored sessions to qualify a model and 38 to dethrone one, so a single
 * uncorrectable bar in one series was stopping the evidence clock for every model in the
 * system, including the only target measured to carry signal.
 *
 * Healing is best-effort by nature: it re-fetches a window that is usually already stored, so
 * the useful outcome is what it repaired, not that every candle was writable. A refusal from
 * the immutability guard is that guard working correctly. The run still exits non-zero at the
 * end when any step failed, so nothing here becomes silent.
 */
async function runCollectionStep(description: string, args: string[]): Promise<void> {
  try {
    await runCommand("npm", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectionFailures.push(`${description}: ${message}`);
    console.error(`\n⚠️ Collection step failed and was skipped — ${description}: ${message}`);
  }
}

async function main(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const nowIso = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    console.info("============== EOD PIPELINE STARTED ==============");

    // 1. Heal the intraday index series from settled Fyers history. The live
    // collector owns current bars, while this pass fills any windows missed by a
    // restart. 30m and 60m are model-research inputs and need the same recovery
    // path as 15m rather than relying on a permanently running process.
    const intradayIndexSeries = ["NIFTY50", "BANKNIFTY"] as const;
    const intradayTimeframes = ["15m", "30m", "60m"] as const;
    for (const instrument of intradayIndexSeries) {
      for (const timeframe of intradayTimeframes) {
        await runCollectionStep(`heal ${instrument} ${timeframe}`, [
          "run", "data:collect:historical", "--",
          "--provider", "fyers",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", sevenDaysAgo,
          "--to", today,
          "--skip-existing",
        ]);
      }
    }

    // 1a. Fetch 1d historical data for both independently-modelled indices and the research pool.
    // This is required before shadow-predict so that 1d models have fresh daily candles to score against.
    const allDailySeries = [
      { symbol: "NIFTY50", provider: "fyers" },
      { symbol: "BANKNIFTY", provider: "fyers" },
      ...RESEARCH_EQUITY_POOL.map((symbol) => ({ symbol, provider: "fyers" })),
      ...RESEARCH_INDEX_POOL.map((symbol) => ({ symbol, provider: "fyers" })),
    ];
    for (const { symbol, provider } of allDailySeries) {
      await runCollectionStep(`collect ${symbol} 1d`, [
        "run", "data:collect:historical", "--",
        "--provider", provider,
        "--instrument", symbol,
        "--timeframe", "1d",
        "--from", sevenDaysAgo,
        "--to", today,
        "--skip-existing"
      ]);
    }

    // A newly collected daily candle needs its derived evidence before the readiness audit and
    // fit. Refresh every member because the pooled model requires a consistent feature layer.
    for (const { symbol } of allDailySeries) {
      await runCommand("npm", [
        "run", "analysis:calculate-indicators", "--",
        "--instrument", symbol,
        "--timeframe", "1d",
        "--from", sevenDaysAgo,
      ]);
      await runCommand("npm", [
        "run", "analysis:detect-patterns", "--",
        "--instrument", symbol,
        "--timeframe", "1d",
        "--from", sevenDaysAgo,
      ]);
    }

    // 1b. Refresh every derived feature used by the intraday model schemas over
    // the healed range. Both commands calculate with full-history context while
    // --from bounds writes to the rows that may have changed.
    for (const instrument of intradayIndexSeries) {
      for (const timeframe of intradayTimeframes) {
        await runCommand("npm", [
          "run", "analysis:calculate-indicators", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", sevenDaysAgo,
        ]);
        await runCommand("npm", [
          "run", "analysis:detect-patterns", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", sevenDaysAgo,
        ]);
      }
    }

    // A collector that restarts during a candle intentionally leaves that partial
    // row incomplete. Settled history above replaces on-grid rows; this removes
    // only remaining orphans older than the readiness audit's one-hour grace.
    await runCommand("npm", ["run", "data:reconcile:provisional"]);

    // 1c. Data-readiness audit (Phase 25, Workstream A). Measures every stored
    // series, assigns READY/DEGRADED/STALE/INVALID, and persists the report the
    // training gate reads. Runs after collection so tonight's bars are measured,
    // before training so no model fits unaudited data. The audit itself exits 0
    // on findings — a DEGRADED series is a finding, not an audit failure.
    await runCommand("npm", ["run", "data:audit"]);

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

    // 2c. Shadow-predict the non-directional candidates. They are excluded from the
    // directional competition pool by design — a volatility model enrolled there once
    // sat permanently unpromotable at the top of a group it could not score in — so they
    // need their own pass or they never write a prediction and settlement (step 2b) has
    // nothing to grade. Scoped by label scheme; writes only to
    // auxiliary_model_predictions.
    //
    // No --instrument: each model scores its own scope. A pooled artifact fans out
    // across its recorded roster; a single-instrument artifact scores its own symbol.
    // Pinning NIFTY50 here made every pooled model (trained on the 20 research
    // equities, which exclude NIFTY50) fail its shadow pass, so the one configuration
    // that cleared the promotion gate could never build settled evidence — and one
    // prediction per session would never reach the volatility competition's 300-row
    // floor anyway, which assumes a pooled model writes one row per member per session.
    //
    // ORDER IS LOAD-BEARING: this must run BEFORE the training steps, and it used to run
    // after them. `deployment_not_before` is max(trainingLabelAvailableEnd, dataCutoffAt)
    // and the training steps pass `--to nowIso`, so a model trained in this run carries a
    // cutoff later than the candle it would score. Predicting before training also
    // guarantees that a newly enrolled family never attempts to backdate a score onto
    // the candle used during its fit.
    //
    // Predicting first uses the model from a previous run, whose cutoff predates today's
    // candle. Verified 2026-08-04: 61 predictions created after the move, 0 before it.
    await runCommand("npm", [
      "run", "ml:predict", "--",
      "--shadow-scheme", "volatility-expansion-v1",
    ]);

    // 3. Train fresh candidates. Deliberately *without* --promote: a one-shot
    // holdout comparison no longer decides production. New candidates enter the
    // competition pool (step 5) and must outperform the champion on live,
    // settled outcomes before the title changes hands.
    //
    // Every scheduled configuration targets volatility expansion, on its own label
    // alphabet. This is the one target measured to carry signal. On NIFTY50 `1d` under
    // CPCV it beat the trivial predictor on macro-F1 *and* accuracy on 100% of splits
    // (0.3982 vs 0.1595, and 0.4043 vs 0.3148), where the directional target won
    // macro-F1 alone; pooled cross-sectionally it reached mean macro-F1 0.4404 over 5
    // folds and again beat trivial on both metrics (0.4509 vs 0.1635, 0.4666 vs 0.3250),
    // the only configuration so far to clear the promotion gate's initial baseline.
    //
    // These models cannot reach a directional consumer: the competition and settlement
    // repositories both filter on `validationProtocol.labelScheme`, so a volatility
    // model is invisible to the directional pool by construction, and informs risk only.
    //
    // No directional configuration is scheduled any more. `eod-training-plan.ts` carries
    // the evidence for each exclusion, including the one question still open on 15m.
    //
    // 3b. Cadence and degradation gate. Each configuration refits once its cadence has
    // elapsed, or earlier when its current PRIMARY has enough live evidence and no longer
    // beats the trivial majority-class predictor on accuracy and macro-F1.
    //
    // Each due fit receives a dated immutable key. Reusing one key would be inert because
    // shadow enrollment is sticky; a new key gives the refit its own live evidence while the
    // stable family identity prevents nightly churn. See `eod-training-plan.ts`.
    //
    // A failure to read recency falls back to training everything, which is the previous
    // behaviour and the safe direction: it wastes compute rather than silently skipping a
    // refit that was due.
    const plan = buildEodTrainingPlan(nowIso, RESEARCH_TRAINING_POOL);
    let latestTrainedAt: ReadonlyMap<string, Date>;
    let degradedModelKeys: ReadonlySet<string>;
    try {
      ({ latestTrainedAt, degradedModelKeys } = await loadModelTrainingState());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n⚠️ Could not read training recency — treating every configuration as due: ${message}`);
      latestTrainedAt = new Map();
      degradedModelKeys = new Set();
    }
    const { due, skipped, degradationTriggered } = selectDueTrainingSteps(
      plan,
      latestTrainedAt,
      new Date(),
      degradedModelKeys,
    );
    for (const trigger of degradationTriggered) {
      console.warn(
        `Live performance triggered an early refit — ${trigger.step.description}: `
        + `${trigger.matchedModelKey} no longer beats the trivial baseline.`,
      );
    }
    for (const held of skipped) {
      console.info(
        `⏭️  Inside refit cadence, skipped — ${held.step.description}: last trained `
        + `${held.lastTrainedAt.toISOString()} (${held.daysSinceLastTrained.toFixed(1)}d ago, `
        + `cadence ${held.step.cadenceDays}d), matched ${held.matchedModelKey}.`,
      );
    }
    console.info(`\nTraining ${due.length} of ${plan.length} configurations.`);

    // Execute the due matrix. BANKNIFTY and NIFTY50 are independent model families and never
    // borrow each other's artifacts; each refused step is isolated by runTrainingStep.
    for (const step of due) {
      await runTrainingStep(step.description, step.args);
    }

    // 4. Volatility competition, on settled non-directional outcomes. Its own table and
    // its own rules: the settled floor is 300 rather than the directional 60, because a
    // pooled model writes one prediction per instrument per session, so sixty rows can be
    // three sessions of twenty correlated names rather than sixty observations. A PRIMARY
    // here informs risk and regime context only.
    await runCommand("npm", ["run", "models:compete:volatility"]);

    // Reported together, and after the competitions have run. Both lists are isolated failures
    // the run survived, so the distinction that matters to a reader is which stage degraded --
    // a skipped heal leaves a gap in one series, a skipped fit leaves a candidate unbuilt, and
    // neither implies the settlement and grading below them were skipped too.
    if (trainingFailures.length > 0 || collectionFailures.length > 0) {
      console.error("\n============== EOD PIPELINE COMPLETE WITH FAILURES ==============");
      for (const failure of collectionFailures) console.error(` - collection — ${failure}`);
      for (const failure of trainingFailures) console.error(` - training — ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.info("============== EOD PIPELINE COMPLETE ==============");
  } catch (error) {
    console.error("EOD Pipeline failed:", error);
    process.exitCode = 1;
  }
}

void main();
