import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  effectiveSampleSize,
  impliedPromotionMargin,
  MINIMUM_BOOTSTRAP_SESSIONS,
  pairedSessionBootstrap,
  sessionBlockBootstrap,
  toConfusionCounts,
  type ConfusionCount,
  type SettledRow,
} from "../../modules/model-predictions/domain/effective-sample-size.js";
import {
  computeVolatilitySettledMetrics,
  DEFAULT_VOLATILITY_COMPETITION_RULES,
  type VolatilityConfusionCell,
} from "../../modules/model-predictions/domain/volatility-competition.js";
import { isVolatilityLabel } from "../../modules/model-predictions/domain/volatility-expansion-label.js";

/**
 * Measures what the volatility competition's settled rows are actually worth, and what promotion
 * margin they support.
 *
 * The margin in `DEFAULT_VOLATILITY_COMPETITION_RULES` is 0.088, derived as two standard errors of
 * a macro-F1 difference at ~250 rows per side *assuming independent rows*. Those rows are not
 * independent: a model writes one per instrument and, on an intraday timeframe, one per bar as well
 * -- the enrolled 15m pool-2 models each held 14 settled rows across 2 instruments on a single
 * session. So the derivation has been standing on an unmeasured assumption.
 * `volatility-competition.ts` says so in as many words and defers to this command.
 *
 * What it reports, per enrolled model:
 *
 * - rows, scored sessions, and mean rows per session (instruments x bars, not roster size)
 * - intraclass correlation of correctness within a session, by ANOVA
 * - the design effect and the effective sample size that follow
 * - a session block bootstrap standard error for macro-F1, and the margin two of those imply
 *
 * And for each pair of models with common sessions, the **paired** bootstrap standard error of
 * their macro-F1 difference -- which is the number the promotion margin should be set from, because
 * competing models score the same market on the same days and their errors are correlated.
 *
 * It is expected to refuse most of this early on, and it says so rather than emitting a number:
 * measured 2026-08-10, the whole scheme had settled on one session, which supports neither an ICC
 * nor a bootstrap. Run it again once `PATTERN_DETECTION_INTRADAY` and the daily settlement have
 * accumulated a few weeks.
 */

interface Options {
  /** Rolling window of settled history to read, in days. */
  windowDays: number;
  resamples: number;
  seed: number;
  /** Target margin to invert for the session requirement. Defaults to the configured margin. */
  targetMargin: number;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }
  const positive = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be positive.`);
    return parsed;
  };
  return {
    windowDays: Math.floor(positive("window-days", 365)),
    resamples: Math.floor(positive("resamples", 2_000)),
    seed: Math.floor(positive("seed", 20_260_810)),
    targetMargin: positive("target-margin", DEFAULT_VOLATILITY_COMPETITION_RULES.promotionMargin),
  };
}

/** Macro-F1 through the competition's own metric code, so the statistic matches the ranking. */
function macroF1(counts: readonly ConfusionCount[]): number | null {
  const cells: VolatilityConfusionCell[] = [];
  for (const count of counts) {
    if (!isVolatilityLabel(count.prediction) || !isVolatilityLabel(count.realizedLabel)) return null;
    cells.push({
      prediction: count.prediction,
      realizedLabel: count.realizedLabel,
      count: count.count,
    });
  }
  return computeVolatilitySettledMetrics(cells).macroF1;
}

/**
 * Sessions needed for the bootstrap standard error to fall under half the target margin.
 *
 * A bootstrap standard error shrinks as 1/sqrt(sessions), so a measurement at `k` sessions
 * extrapolates to `k * (measured / required)^2`. Labelled an extrapolation in the output because it
 * is one: it assumes the correlation structure of the next hundred sessions resembles the measured
 * ones, which is exactly the kind of assumption this command exists to stop making silently.
 */
function sessionsForMargin(
  measuredStandardError: number,
  measuredSessions: number,
  targetMargin: number,
): number {
  const required = targetMargin / 2;
  if (required <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(measuredSessions * (measuredStandardError / required) ** 2);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const result = await database.query<{
      model_key: string;
      role: string | null;
      session: string;
      prediction: string;
      realized_label: string;
      row_count: string;
    }>(`
      SELECT
        mv.model_key,
        vcs.role,
        (amp.label_available_at AT TIME ZONE 'Asia/Kolkata')::date::text AS session,
        amp.prediction,
        amp.realized_label,
        count(*)::text AS row_count
      FROM volatility_shadow_enrollments vse
      JOIN model_versions mv ON mv.id = vse.model_version_id
      JOIN auxiliary_model_predictions amp ON amp.model_version_id = mv.id
      LEFT JOIN volatility_competition_state vcs ON vcs.model_version_id = mv.id
      WHERE vse.label_scheme = 'volatility-expansion-v1'
        AND amp.settled_at IS NOT NULL
        AND amp.realized_label IS NOT NULL
        AND amp.label_available_at >= NOW() - ($1 || ' days')::interval
      GROUP BY mv.model_key, vcs.role, session, amp.prediction, amp.realized_label
      ORDER BY mv.model_key, session
    `, [options.windowDays]);

    // Expanded back to one entry per row: the statistics are defined over rows, and collapsing
    // them into counts here would lose the session each row belongs to.
    const byModel = new Map<string, { role: string | null; rows: SettledRow[] }>();
    for (const row of result.rows) {
      const entry = byModel.get(row.model_key) ?? { role: row.role, rows: [] };
      for (let index = 0; index < Number(row.row_count); index += 1) {
        entry.rows.push({
          session: row.session,
          prediction: row.prediction,
          realizedLabel: row.realized_label,
        });
      }
      byModel.set(row.model_key, entry);
    }

    if (byModel.size === 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Effective sample size: no settled volatility predictions in window",
        windowDays: options.windowDays,
      }, null, 2));
      return;
    }

    const models = [...byModel.entries()]
      .map(([modelKey, entry]) => {
        const ess = effectiveSampleSize(entry.rows);
        const bootstrap = sessionBlockBootstrap(entry.rows, macroF1, {
          resamples: options.resamples,
          seed: options.seed,
        });
        return {
          modelKey,
          role: entry.role,
          rows: ess.rows,
          sessions: ess.sessions,
          // Rows per session, which is instruments x bars-per-session -- not the roster size. A
          // 15m pool-2 model contributes 14 rows a session, not 2.
          meanRowsPerSession: ess.sessions === 0 ? 0 : Number((ess.rows / ess.sessions).toFixed(2)),
          observedMacroF1: round(macroF1(toConfusionCounts(entry.rows))),
          intraclassCorrelation: round(ess.rho),
          designEffect: round(ess.designEffect),
          effectiveSampleSize: ess.effectiveSampleSize === null
            ? null
            : Number(ess.effectiveSampleSize.toFixed(1)),
          /** How much of the row count survives the clustering discount. */
          essPerRow: ess.effectiveSampleSize === null || ess.rows === 0
            ? null
            : Number((ess.effectiveSampleSize / ess.rows).toFixed(4)),
          macroF1StandardError: round(bootstrap.standardError),
          refusals: [ess.refusal, bootstrap.refusal].filter((value): value is string => value !== null),
        };
      })
      .sort((left, right) => right.rows - left.rows);

    // Every unordered pair with any shared session. The paired standard error is the figure the
    // margin should be set from, so it is reported per pair rather than summarised away.
    const keys = models.map((model) => model.modelKey);
    const pairs: Array<Record<string, unknown>> = [];
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        const a = byModel.get(keys[left]!)!;
        const b = byModel.get(keys[right]!)!;
        const paired = pairedSessionBootstrap(a.rows, b.rows, macroF1, {
          resamples: options.resamples,
          seed: options.seed,
        });
        if (paired.commonSessions === 0) continue;
        pairs.push({
          left: keys[left],
          right: keys[right],
          commonSessions: paired.commonSessions,
          droppedSessions: paired.droppedSessions,
          macroF1DifferenceStandardError: round(paired.standardError),
          impliedMargin: paired.standardError === null
            ? null
            : impliedPromotionMargin(paired.standardError),
          sessionsForTargetMargin: paired.standardError === null
            ? null
            : sessionsForMargin(paired.standardError, paired.commonSessions, options.targetMargin),
          refusal: paired.refusal,
        });
      }
    }

    const usablePairs = pairs.filter((pair) => pair.macroF1DifferenceStandardError !== null);
    console.info(JSON.stringify({
      level: "info",
      message: "Effective sample size measurement",
      protocol: {
        windowDays: options.windowDays,
        resamples: options.resamples,
        seed: options.seed,
        resamplingUnit: "IST session (the conservative independent unit)",
        statistic: "macro-F1, via computeVolatilitySettledMetrics",
        minimumSessionsForBootstrap: MINIMUM_BOOTSTRAP_SESSIONS,
        configuredMargin: DEFAULT_VOLATILITY_COMPETITION_RULES.promotionMargin,
        configuredScoredDaysForPromotion:
          DEFAULT_VOLATILITY_COMPETITION_RULES.minimumScoredDaysForPromotion,
        targetMargin: options.targetMargin,
      },
      models,
      pairs,
      verdict: usablePairs.length === 0
        ? "INSUFFICIENT_DATA: no model pair has enough common scored sessions for a paired "
          + "bootstrap. The configured margin and session gate remain unvalidated by measurement. "
          + "Re-run once settlement has accumulated more sessions."
        : "MEASURED: compare each pair's impliedMargin against configuredMargin, and "
          + "sessionsForTargetMargin against configuredScoredDaysForPromotion.",
    }, null, 2));
  } finally {
    await database.end();
  }
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(4));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Effective sample size measurement failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
