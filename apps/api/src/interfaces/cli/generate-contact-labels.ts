import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { getOption } from "./arguments.js";
import {
  CANDIDATE_VERSION_CURRENT,
  CANDIDATE_VERSION_LEGACY,
  LABELING_VERSION_CURRENT,
} from "../../modules/technical-analysis/domain/ict/liquidity-label-versions.js";

/**
 * Liquidity Intelligence Engine v1 — Phase 2
 *
 * Contact Label Generator  (labeling_version = 'v2-causal')
 *
 * For every candidate in `liquidity_pool_candidates`, looks forward in the
 * 1m candle series and records whether price contacted (or breached) the pool
 * within each pre-registered horizon.
 *
 * Design invariants (pre-registered, not tuned against outcomes):
 *   - Epsilon (ε): 10 bps of pool price — contact tolerance.
 *   - Delta (δ): 5 bps of pool price — breach tolerance beyond the pool.
 *   - Active guard: price must be >= 2ε away from the pool when the level becomes
 *     OBSERVABLE (see below). If price is already at the pool, the label is
 *     is_active_candidate = false.
 *   - Horizons: 60s, 120s, 300s, 900s (elapsed EXCHANGE time, never row counts).
 *   - Forward path: 1m BANKNIFTY candles are the finest available price data.
 *
 * ## v2-causal fixes (the v1-legacy labels leaked look-ahead and must not be used)
 *
 * 1. Window start. `known_at_time` is, by the repo stamp convention (see
 *    `technical-analysis/domain/ict/causal-pivot.ts`), the OPEN of the bar whose close revealed the
 *    level. v1 started the forward window at `known_at_time`, so for a 5m candidate the first 300s
 *    WAS the confirming bar -- before the level was observable (5m SESSION_HIGH/LOW: 5646/5646
 *    contacted, 0 breached; 5m swing levels at 300s breached = 0 by construction). v2 starts the
 *    window at `observable_at = known_at_time + timeframe` (the confirming bar's CLOSE); the
 *    confirming bar is never inside it, and `price_at_known` is the close at that same instant.
 * 2. Horizon honesty. A "30s" horizon computed from 1m bars spans 60s. v2 only counts 1m bars that
 *    CLOSE inside the horizon, so the finest honest horizon on 1m bars is 60s; there is no 30s
 *    label. (A true 30s label needs sub-bar data, which does not exist for the cash index.)
 * 3. contact_time is the CLOSE of the first touching bar (`open_time + 1m`), not its open.
 * 4. Partial coverage. If the window is not fully covered by bars (data end, gap), "not touched" is
 *    UNKNOWN (NULL), never FALSE. A touch seen in a partial window is still a real touch.
 *
 * The labeling SQL runs as a LATERAL join directly in Postgres for efficiency —
 * no row-by-row TypeScript iteration. `computeContactLabel` below is the executable reference
 * specification of the same rules (and what the unit tests exercise).
 *
 * Usage:
 *   node generate-contact-labels.js \
 *     [--timeframe=5m]         (filter candidates by source timeframe; default = all)
 *     [--candidate-version=v2-dedup|v1-legacy|all]  (default v2-dedup)
 *     [--epsilon-bps=10]       (pre-registered, do NOT change after inspecting results)
 *     [--delta-bps=5]          (pre-registered breach threshold)
 *     [--dry-run]
 */

/** 30s is deliberately absent: 1m bars cannot resolve it (see header, point 2). */
export const HORIZONS_SECONDS = [60, 120, 300, 900] as const;
export type HorizonSeconds = (typeof HORIZONS_SECONDS)[number];

/** Width of the forward bars (1m candles), in seconds. */
export const FORWARD_BAR_SECONDS = 60;

/** Candidate-timeframe -> bar length in seconds (the confirming bar's span). Unknown => unlabelled. */
export const TIMEFRAME_SECONDS: Readonly<Record<string, number>> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
};

// ─────────────────────────── Reference implementation ────────────────────────

export interface LabelBar {
  /** Open time of the (1m) bar. */
  readonly openTime: Date;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface LabelCandidate {
  readonly side: "UP" | "DOWN";
  readonly poolPrice: number;
  /** Stamp-convention time: the OPEN of the bar whose close revealed the level. */
  readonly knownAtTime: Date;
  readonly timeframeSeconds: number;
}

export interface ContactLabel {
  /** known_at_time + timeframe: the first instant the level is observable. */
  readonly observableAt: Date;
  readonly priceAtKnown: number;
  readonly distanceBps: number;
  readonly isActiveCandidate: boolean;
  /** null = unknown (window not fully covered and no touch seen). */
  readonly contacted: boolean | null;
  readonly breached: boolean | null;
  /** CLOSE of the first touching bar. */
  readonly contactTime: Date | null;
  readonly barsInWindow: number;
}

/**
 * Reference implementation of the v2-causal labeling rules (mirrors `buildLabelQuery`).
 * Returns null when no price is available at `observable_at` (the SQL excludes such rows).
 */
export function computeContactLabel(
  candidate: LabelCandidate,
  bars: readonly LabelBar[],
  horizonSeconds: number,
  opts: { epsilonBps?: number; deltaBps?: number } = {}
): ContactLabel | null {
  const epsilon = (opts.epsilonBps ?? 10) / 10000;
  const delta = (opts.deltaBps ?? 5) / 10000;
  const activeGuard = ((opts.epsilonBps ?? 10) * 2) / 10000;
  const barMs = FORWARD_BAR_SECONDS * 1000;
  const observableMs = candidate.knownAtTime.getTime() + candidate.timeframeSeconds * 1000;
  const windowEndMs = observableMs + horizonSeconds * 1000;
  const pool = candidate.poolPrice;

  // price_at_known: close of the last bar that has CLOSED by observable_at.
  let priceBar: LabelBar | null = null;
  for (const b of bars) {
    const t = b.openTime.getTime();
    if (t + barMs <= observableMs && (priceBar === null || t > priceBar.openTime.getTime())) priceBar = b;
  }
  if (priceBar === null) return null;
  const priceAtKnown = priceBar.close;

  const distanceBps =
    candidate.side === "UP"
      ? ((pool - priceAtKnown) / pool) * 10000
      : ((priceAtKnown - pool) / pool) * 10000;
  const isActiveCandidate =
    candidate.side === "UP"
      ? (pool - priceAtKnown) / pool > activeGuard
      : (priceAtKnown - pool) / pool > activeGuard;

  // Forward window: bars that open at/after observable_at and CLOSE by observable_at + horizon.
  const window = bars.filter((b) => {
    const t = b.openTime.getTime();
    return t >= observableMs && t + barMs <= windowEndMs;
  });
  const expectedBars = Math.floor(horizonSeconds / FORWARD_BAR_SECONDS);

  const touches = (b: LabelBar): boolean =>
    candidate.side === "UP" ? b.high >= pool - pool * epsilon : b.low <= pool + pool * epsilon;
  const breaches = (b: LabelBar): boolean =>
    candidate.side === "UP" ? b.high >= pool + pool * delta : b.low <= pool - pool * delta;

  const touching = window.filter(touches).sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const fullWindow = window.length >= expectedBars;
  const contacted = touching.length > 0 ? true : fullWindow ? false : null;
  const breached = window.some(breaches) ? true : fullWindow ? false : null;

  return {
    observableAt: new Date(observableMs),
    priceAtKnown,
    distanceBps,
    isActiveCandidate,
    contacted,
    breached,
    contactTime: touching.length > 0 ? new Date(touching[0]!.openTime.getTime() + barMs) : null,
    barsInWindow: window.length,
  };
}

// ─────────────────────────── CLI ─────────────────────────────────────────────

const TIMEFRAME_PATTERN = /^[0-9]+[mhd]$/;
type CandidateVersionFilter = typeof CANDIDATE_VERSION_CURRENT | typeof CANDIDATE_VERSION_LEGACY | "all";

function parseCandidateVersion(raw: string | undefined): CandidateVersionFilter {
  const v = raw ?? CANDIDATE_VERSION_CURRENT;
  if (v === CANDIDATE_VERSION_CURRENT || v === CANDIDATE_VERSION_LEGACY || v === "all") return v;
  throw new Error(`Invalid --candidate-version=${v}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeframeFilter = getOption(args, "timeframe") ?? null;
  if (timeframeFilter !== null && !TIMEFRAME_PATTERN.test(timeframeFilter)) {
    throw new Error(`Invalid --timeframe=${timeframeFilter}`);
  }
  const candidateVersion = parseCandidateVersion(getOption(args, "candidate-version"));
  const epsilonBps = Number(getOption(args, "epsilon-bps") ?? "10");
  const deltaBps = Number(getOption(args, "delta-bps") ?? "5");
  if (!Number.isFinite(epsilonBps) || !Number.isFinite(deltaBps)) {
    throw new Error("--epsilon-bps and --delta-bps must be finite numbers");
  }
  const dryRun = args.includes("--dry-run");
  const runId = `phase2-${LABELING_VERSION_CURRENT}-${timeframeFilter ?? "all"}-eps${epsilonBps}-${Date.now()}`;

  const env = loadEnvironment();
  const database = createDatabasePool(env.DATABASE_URL);

  try {
    // ── Count eligible candidates ────────────────────────────────────────────
    const countResult = await database.query<{ count: string }>(
      `SELECT count(*) FROM liquidity_pool_candidates
       WHERE ($1::text IS NULL OR timeframe = $1)
         AND ($2::text = 'all' OR candidate_version = $2)`,
      [timeframeFilter, candidateVersion]
    );
    const totalCandidates = Number(countResult.rows[0]!.count);

    console.info(JSON.stringify({
      level: "info",
      message: "Phase 2: starting contact label generation",
      labelingVersion: LABELING_VERSION_CURRENT,
      candidateVersion,
      timeframeFilter,
      epsilonBps,
      deltaBps,
      horizons: HORIZONS_SECONDS,
      totalCandidates,
      dryRun,
      runId,
    }));

    if (dryRun) {
      // In dry-run mode, just preview what the labeling SQL would produce
      // for a small sample without writing anything.
      const preview = await database.query(
        buildLabelQuery({ epsilonBps, deltaBps, horizonSeconds: 300, timeframeFilter, candidateVersion, limit: 5 })
      );
      console.info(JSON.stringify({
        level: "info",
        message: "Dry run: sample of 5 labels at 5m horizon",
        sample: preview.rows,
      }));
      return;
    }

    // ── Run labeling for each horizon ─────────────────────────────────────────
    let totalInserted = 0;
    for (const horizonSeconds of HORIZONS_SECONDS) {
      console.info(JSON.stringify({
        level: "info",
        message: `Phase 2: labeling horizon ${horizonSeconds}s`,
        horizonSeconds,
      }));

      const result = await database.query(
        buildInsertQuery({ epsilonBps, deltaBps, horizonSeconds, timeframeFilter, candidateVersion, runId })
      );
      const inserted = result.rowCount ?? 0;
      totalInserted += inserted;

      console.info(JSON.stringify({
        level: "info",
        message: `Phase 2: horizon ${horizonSeconds}s complete`,
        horizonSeconds,
        inserted,
      }));
    }

    // ── Summary stats ─────────────────────────────────────────────────────────
    const stats = await database.query<{
      horizon_seconds: number;
      active: string;
      contacted: string;
      contact_rate: string;
    }>(
      `SELECT
         horizon_seconds,
         count(*) FILTER (WHERE is_active_candidate) AS active,
         count(*) FILTER (WHERE is_active_candidate AND contacted) AS contacted,
         round(
           100.0 * count(*) FILTER (WHERE is_active_candidate AND contacted) /
           nullif(count(*) FILTER (WHERE is_active_candidate AND contacted IS NOT NULL), 0),
         2) AS contact_rate
       FROM liquidity_contact_labels
       WHERE labeling_run_id = $1
         AND labeling_version = '${LABELING_VERSION_CURRENT}'
       GROUP BY 1
       ORDER BY 1`,
      [runId]
    );

    console.info(JSON.stringify({
      level: "info",
      message: "Phase 2: complete",
      totalInserted,
      runId,
      contactRateByHorizon: stats.rows,
    }));
  } finally {
    await database.end();
  }
}

// ─────────────────────────── SQL builders ────────────────────────────────────

export interface LabelQueryOptions {
  epsilonBps: number;
  deltaBps: number;
  horizonSeconds: HorizonSeconds;
  timeframeFilter: string | null;
  candidateVersion?: CandidateVersionFilter;
  limit?: number;
}

function timeframeSecondsSqlCase(column: string): string {
  const arms = Object.entries(TIMEFRAME_SECONDS)
    .map(([tf, seconds]) => `WHEN '${tf}' THEN ${seconds}`)
    .join(" ");
  return `CASE ${column} ${arms} END`;
}

/**
 * Builds the SELECT that computes contact labels for one horizon (labeling_version v2-causal).
 *
 * Design notes:
 * - `observable_at` = known_at_time + timeframe: the CLOSE of the confirming bar, the first instant
 *   a live system can act on the level. The forward window and `price_at_known` both start here.
 * - `price_at_known`: the close of the last complete 1m candle that has CLOSED by `observable_at`.
 * - `is_active_candidate`: price must be at least 2ε away from the pool at `observable_at`.
 *   If price is already at (or through) the pool, the outcome is ambiguous and we mark
 *   it inactive rather than contaminating the label.
 * - Forward path: 1m candles that open at/after `observable_at` and CLOSE within the horizon.
 *   The confirming bar is never inside the window.
 * - `contacted/breached = NULL` when the window is not fully covered and nothing was seen
 *   (honest unknown, not false). `contact_time` is the touch bar's CLOSE.
 */
export function buildLabelQuery(opts: LabelQueryOptions): string {
  const { epsilonBps, deltaBps, horizonSeconds, timeframeFilter, limit } = opts;
  const candidateVersion = opts.candidateVersion ?? CANDIDATE_VERSION_CURRENT;
  const epsilonFraction = epsilonBps / 10000;
  const deltaFraction = deltaBps / 10000;
  const activeGuardFraction = (epsilonBps * 2) / 10000;
  const expectedBars = Math.floor(horizonSeconds / FORWARD_BAR_SECONDS);
  const barInterval = `INTERVAL '${FORWARD_BAR_SECONDS} seconds'`;

  if (timeframeFilter !== null && !TIMEFRAME_PATTERN.test(timeframeFilter)) {
    throw new Error(`Invalid timeframe filter: ${timeframeFilter}`);
  }

  return `
  WITH price_context AS (
    -- Price at the moment the level became OBSERVABLE: the close of the last complete 1m bar of the
    -- SAME instrument that has closed by observable_at (= known_at_time + candidate timeframe).
    SELECT
      lpc.id AS candidate_id,
      lpc.instrument_id,
      lpc.pool_type,
      lpc.side,
      lpc.price AS pool_price,
      lpc.known_at_time,
      lpc.timeframe AS candidate_timeframe,
      lpc.known_at_time + tf.seconds * INTERVAL '1 second' AS observable_at,
      (
        SELECT c.close::numeric
        FROM candles c
        WHERE c.instrument_id = lpc.instrument_id
          AND c.timeframe = '1m'
          AND c.open_time + ${barInterval} <= lpc.known_at_time + tf.seconds * INTERVAL '1 second'
          AND c.is_complete = true
        ORDER BY c.open_time DESC
        LIMIT 1
      ) AS price_at_known
    FROM liquidity_pool_candidates lpc
    CROSS JOIN LATERAL (SELECT ${timeframeSecondsSqlCase("lpc.timeframe")} AS seconds) tf
    WHERE tf.seconds IS NOT NULL
      AND (${timeframeFilter ? `lpc.timeframe = '${timeframeFilter}'` : "TRUE"})
      AND (${candidateVersion === "all" ? "TRUE" : `lpc.candidate_version = '${candidateVersion}'`})
  ),
  labelled AS (
    SELECT
      pc.candidate_id,
      pc.price_at_known,
      pc.pool_price,
      pc.side,
      pc.known_at_time,
      -- Distance in bps from price to pool (positive = away from pool)
      CASE
        WHEN pc.side = 'UP' THEN
          round((pc.pool_price - pc.price_at_known) / pc.pool_price * 10000, 4)
        WHEN pc.side = 'DOWN' THEN
          round((pc.price_at_known - pc.pool_price) / pc.pool_price * 10000, 4)
      END AS distance_bps,
      ${epsilonBps}::numeric AS epsilon_bps,
      -- Active guard: price must be at least 2ε away from the pool.
      CASE
        WHEN pc.price_at_known IS NULL THEN FALSE
        WHEN pc.side = 'UP' THEN
          (pc.pool_price - pc.price_at_known) / pc.pool_price > ${activeGuardFraction}
        WHEN pc.side = 'DOWN' THEN
          (pc.price_at_known - pc.pool_price) / pc.pool_price > ${activeGuardFraction}
        ELSE FALSE
      END AS is_active_candidate,
      -- Forward path lookup via LATERAL
      fwd.contacted,
      fwd.breached,
      fwd.contact_time,
      fwd.max_excursion_toward_bps
    FROM price_context pc
    LEFT JOIN LATERAL (
      SELECT
        -- CONTACT: did price reach within ε of the pool? TRUE if seen; FALSE only on a FULLY covered
        -- window; otherwise unknown (NULL).
        CASE
          WHEN (CASE
                  WHEN pc.side = 'UP' THEN bool_or(c.high::numeric >= pc.pool_price - (pc.pool_price * ${epsilonFraction}))
                  WHEN pc.side = 'DOWN' THEN bool_or(c.low::numeric <= pc.pool_price + (pc.pool_price * ${epsilonFraction}))
                END) THEN TRUE
          WHEN count(*) >= ${expectedBars} THEN FALSE
          ELSE NULL
        END AS contacted,
        -- BREACH: did price go clearly through the pool? Same unknown-vs-false rule.
        CASE
          WHEN (CASE
                  WHEN pc.side = 'UP' THEN bool_or(c.high::numeric >= pc.pool_price + (pc.pool_price * ${deltaFraction}))
                  WHEN pc.side = 'DOWN' THEN bool_or(c.low::numeric <= pc.pool_price - (pc.pool_price * ${deltaFraction}))
                END) THEN TRUE
          WHEN count(*) >= ${expectedBars} THEN FALSE
          ELSE NULL
        END AS breached,
        -- TIME of first contact: the CLOSE of the first touching bar (never its open).
        CASE
          WHEN pc.side = 'UP' THEN
            min(c.open_time + ${barInterval}) FILTER (
              WHERE c.high::numeric >= pc.pool_price - (pc.pool_price * ${epsilonFraction})
            )
          WHEN pc.side = 'DOWN' THEN
            min(c.open_time + ${barInterval}) FILTER (
              WHERE c.low::numeric <= pc.pool_price + (pc.pool_price * ${epsilonFraction})
            )
        END AS contact_time,
        -- Max excursion toward the pool from price_at_known, in bps of the pool price (>= 0).
        CASE
          WHEN pc.side = 'UP' THEN
            round(greatest(0, max(c.high::numeric) - pc.price_at_known) / pc.pool_price * 10000, 4)
          WHEN pc.side = 'DOWN' THEN
            round(greatest(0, pc.price_at_known - min(c.low::numeric)) / pc.pool_price * 10000, 4)
        END AS max_excursion_toward_bps
      FROM candles c
      WHERE c.instrument_id = pc.instrument_id
        AND c.timeframe = '1m'
        AND c.is_complete = true
        -- Strictly AFTER the confirming bar: the window opens at its close ...
        AND c.open_time >= pc.observable_at
        -- ... and only bars that CLOSE inside the horizon count (a 1m bar cannot resolve < 60s).
        AND c.open_time + ${barInterval} <= pc.observable_at + ${horizonSeconds} * INTERVAL '1 second'
    ) fwd ON true
    WHERE pc.price_at_known IS NOT NULL
  )
  SELECT
    candidate_id,
    price_at_known,
    distance_bps,
    epsilon_bps,
    is_active_candidate,
    contacted,
    breached,
    contact_time,
    max_excursion_toward_bps
  FROM labelled
  ${limit ? `LIMIT ${limit}` : ""}
  `;
}

export function buildInsertQuery(
  opts: LabelQueryOptions & { runId: string }
): string {
  const selectSql = buildLabelQuery(opts);
  return `
  INSERT INTO liquidity_contact_labels
    (candidate_id, horizon_seconds, price_at_known, distance_bps,
     epsilon_bps, is_active_candidate, contacted, breached,
     contact_time, max_excursion_toward_bps, labeling_run_id, labeling_version)
  SELECT
    candidate_id,
    ${opts.horizonSeconds},
    price_at_known,
    distance_bps,
    epsilon_bps,
    is_active_candidate,
    contacted,
    breached,
    contact_time,
    max_excursion_toward_bps,
    '${opts.runId}',
    '${LABELING_VERSION_CURRENT}'
  FROM (${selectSql}) subq
  ON CONFLICT (candidate_id, horizon_seconds, labeling_version) DO NOTHING
  `;
}

// ─────────────────────────── Entry point ─────────────────────────────────────

if (process.argv[1]?.includes("generate-contact-labels")) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: "error", message: String(err) }));
    process.exit(1);
  });
}
