import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { getOption } from "./arguments.js";

/**
 * Liquidity Intelligence Engine v1 — Phase 2
 *
 * Contact Label Generator
 *
 * For every candidate in `liquidity_pool_candidates`, looks forward in the
 * 1m candle series and records whether price contacted (or breached) the pool
 * within each pre-registered horizon.
 *
 * Design invariants (pre-registered, not tuned against outcomes):
 *   - Epsilon (ε): 10 bps of pool price — contact tolerance.
 *   - Delta (δ): 5 bps of pool price — breach tolerance beyond the pool.
 *   - Active guard: price must be >= 2ε away from the pool at known_at_time
 *     to be labelled. If price is already at the pool, the label is
 *     is_active_candidate = false and contacted/breached = NULL.
 *   - Horizons: 30s, 120s, 300s, 900s (elapsed EXCHANGE time, never row counts).
 *   - Forward path: 1m BANKNIFTY candles are the finest available price data.
 *   - Missing forward data: if no 1m candle exists beyond known_at_time within
 *     the horizon, contacted = NULL (unknown, not false).
 *
 * The labeling SQL runs as a LATERAL join directly in Postgres for efficiency —
 * no row-by-row TypeScript iteration.
 *
 * Usage:
 *   node generate-contact-labels.js \
 *     [--timeframe=5m]         (filter candidates by source timeframe; default = all)
 *     [--epsilon-bps=10]       (pre-registered, do NOT change after inspecting results)
 *     [--delta-bps=5]          (pre-registered breach threshold)
 *     [--dry-run]
 */

const HORIZONS_SECONDS = [30, 120, 300, 900] as const;
type HorizonSeconds = (typeof HORIZONS_SECONDS)[number];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeframeFilter = getOption(args, "timeframe") ?? null;
  const epsilonBps = Number(getOption(args, "epsilon-bps") ?? "10");
  const deltaBps = Number(getOption(args, "delta-bps") ?? "5");
  const dryRun = args.includes("--dry-run");
  const runId = `phase2-${timeframeFilter ?? "all"}-eps${epsilonBps}-${Date.now()}`;

  const env = loadEnvironment();
  const database = createDatabasePool(env.DATABASE_URL);

  try {
    // ── Count eligible candidates ────────────────────────────────────────────
    const countResult = await database.query<{ count: string }>(
      `SELECT count(*) FROM liquidity_pool_candidates
       WHERE ($1::text IS NULL OR timeframe = $1)`,
      [timeframeFilter]
    );
    const totalCandidates = Number(countResult.rows[0]!.count);

    console.info(JSON.stringify({
      level: "info",
      message: "Phase 2: starting contact label generation",
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
        buildLabelQuery({ epsilonBps, deltaBps, horizonSeconds: 300, timeframeFilter, limit: 5 })
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
        buildInsertQuery({ epsilonBps, deltaBps, horizonSeconds, timeframeFilter, runId })
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

interface LabelQueryOptions {
  epsilonBps: number;
  deltaBps: number;
  horizonSeconds: HorizonSeconds;
  timeframeFilter: string | null;
  limit?: number;
}

/**
 * Builds the SELECT that computes contact labels for one horizon.
 *
 * Design notes:
 * - `price_at_known`: the close of the last completed 1m candle whose
 *   open_time is strictly < candidate.known_at_time. This is the price a
 *   live system could observe at the moment the candidate became knowable.
 * - `is_active_candidate`: price must be at least 2ε away from the pool.
 *   If price is already at the pool, the outcome is ambiguous and we mark
 *   it inactive rather than contaminating the label.
 * - Forward path: 1m candles from [known_at_time, known_at_time + H).
 *   The LATERAL join scans only the relevant time window per candidate.
 * - `contacted = NULL` when no 1m candles exist in the horizon
 *   (no forward data available — honest unknown, not false).
 */
function buildLabelQuery(opts: LabelQueryOptions & { limit?: number }): string {
  const { epsilonBps, deltaBps, horizonSeconds, timeframeFilter, limit } = opts;
  const epsilonFraction = epsilonBps / 10000;
  const deltaFraction = deltaBps / 10000;
  const activeGuardFraction = (epsilonBps * 2) / 10000;

  return `
  WITH price_context AS (
    -- Price at the moment the candidate became knowable: close of the last
    -- completed 1m bar of the SAME instrument strictly before known_at_time.
    SELECT
      lpc.id AS candidate_id,
      lpc.instrument_id,
      lpc.pool_type,
      lpc.side,
      lpc.price AS pool_price,
      lpc.known_at_time,
      lpc.timeframe AS candidate_timeframe,
      (
        SELECT c.close::numeric
        FROM candles c
        WHERE c.instrument_id = lpc.instrument_id
          AND c.timeframe = '1m'
          AND c.open_time < lpc.known_at_time
          AND c.is_complete = true
        ORDER BY c.open_time DESC
        LIMIT 1
      ) AS price_at_known
    FROM liquidity_pool_candidates lpc
    WHERE (${timeframeFilter ? `lpc.timeframe = '${timeframeFilter}'` : "TRUE"})
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
      fwd.has_forward_data,
      fwd.contacted,
      fwd.breached,
      fwd.contact_time,
      fwd.max_excursion_toward_bps
    FROM price_context pc
    LEFT JOIN LATERAL (
      SELECT
        count(*) > 0 AS has_forward_data,
        -- CONTACT: did price reach within ε of the pool?
        CASE
          WHEN pc.side = 'UP' THEN
            bool_or(c.high::numeric >= pc.pool_price - (pc.pool_price * ${epsilonFraction}))
          WHEN pc.side = 'DOWN' THEN
            bool_or(c.low::numeric <= pc.pool_price + (pc.pool_price * ${epsilonFraction}))
          ELSE FALSE
        END AS contacted,
        -- BREACH: did price go clearly through the pool?
        CASE
          WHEN pc.side = 'UP' THEN
            bool_or(c.high::numeric >= pc.pool_price + (pc.pool_price * ${deltaFraction}))
          WHEN pc.side = 'DOWN' THEN
            bool_or(c.low::numeric <= pc.pool_price - (pc.pool_price * ${deltaFraction}))
          ELSE FALSE
        END AS breached,
        -- TIME of first contact
        CASE
          WHEN pc.side = 'UP' THEN
            min(c.open_time) FILTER (
              WHERE c.high::numeric >= pc.pool_price - (pc.pool_price * ${epsilonFraction})
            )
          WHEN pc.side = 'DOWN' THEN
            min(c.open_time) FILTER (
              WHERE c.low::numeric <= pc.pool_price + (pc.pool_price * ${epsilonFraction})
            )
        END AS contact_time,
        -- Max excursion toward pool (how close did price get, in bps)
        CASE
          WHEN pc.side = 'UP' THEN
            round((pc.pool_price - min(pc.pool_price - c.high::numeric)) / pc.pool_price * 10000, 4)
          WHEN pc.side = 'DOWN' THEN
            round((pc.pool_price - min(c.low::numeric - pc.pool_price)) / pc.pool_price * 10000, 4)
        END AS max_excursion_toward_bps
      FROM candles c
      WHERE c.instrument_id = pc.instrument_id
        AND c.timeframe = '1m'
        AND c.is_complete = true
        AND c.open_time >= pc.known_at_time
        AND c.open_time < pc.known_at_time + INTERVAL '${horizonSeconds} seconds'
    ) fwd ON true
    WHERE pc.price_at_known IS NOT NULL
  )
  SELECT
    candidate_id,
    price_at_known,
    distance_bps,
    epsilon_bps,
    is_active_candidate,
    -- NULL when no forward data (honest unknown)
    CASE WHEN has_forward_data THEN contacted ELSE NULL END AS contacted,
    CASE WHEN has_forward_data THEN breached ELSE NULL END AS breached,
    contact_time,
    max_excursion_toward_bps
  FROM labelled
  ${limit ? `LIMIT ${limit}` : ""}
  `;
}

function buildInsertQuery(
  opts: LabelQueryOptions & { runId: string }
): string {
  const selectSql = buildLabelQuery(opts);
  return `
  INSERT INTO liquidity_contact_labels
    (candidate_id, horizon_seconds, price_at_known, distance_bps,
     epsilon_bps, is_active_candidate, contacted, breached,
     contact_time, max_excursion_toward_bps, labeling_run_id)
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
    '${opts.runId}'
  FROM (${selectSql}) subq
  ON CONFLICT (candidate_id, horizon_seconds) DO NOTHING
  `;
}

// ─────────────────────────── Entry point ─────────────────────────────────────

if (process.argv[1]?.includes("generate-contact-labels")) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: "error", message: String(err) }));
    process.exit(1);
  });
}
