import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import type { PersistedCandle } from "../../modules/market-data/domain/candle.js";
import { IctSessionLevelTracker } from "../../modules/technical-analysis/domain/ict/session-levels.js";
import { findConfirmedPivotAt, type CausalCandle } from "../../modules/technical-analysis/domain/ict/causal-pivot.js";
import { requireOption, getOption } from "./arguments.js";
import { CANDIDATE_VERSION_CURRENT } from "../../modules/technical-analysis/domain/ict/liquidity-label-versions.js";

/**
 * Liquidity Intelligence Engine v1 — Phase 1
 *
 * Generates the `liquidity_pool_candidates` table deterministically from historical
 * price data. This script is a pure research instrument: it does not train any model,
 * does not inspect contact statistics, and does not alter its pool definitions based
 * on observed outcomes.
 *
 * INVARIANT: candidate.known_at_time >= candidate.created_at_time for every row.
 * This is asserted at write time and will throw if violated.
 *
 * Candidates are written as `candidate_version = 'v2-dedup'`: one row per
 * (instrument, timeframe, pool_type, price, session_date), enforced by a partial UNIQUE index
 * (migration 132). The legacy generator re-registered a breached PDH/PDL on every later bar;
 * rows it produced carry `candidate_version = 'v1-legacy'` and must not be mixed with these.
 *
 * Supported pool types (v1 only):
 *   PDH / PDL           - Previous Day High/Low (known at session open)
 *   SESSION_HIGH/LOW    - Rolling intra-session extremes (known as they form)
 *   SWING_HIGH/LOW      - Causal fractal pivots (known at candidateIndex + pivotLength)
 *   ITH / ITL           - Intermediate term pivots (known when right-side swing confirms)
 *
 * Deferred to later phases: Equal Highs/Lows, Order Block liquidity, FVG liquidity.
 *
 * Usage:
 *   node generate-liquidity-candidates.js \
 *     --symbol=BANKNIFTY \
 *     --timeframe=5m \
 *     [--pivot-length=5] \
 *     [--dry-run]
 */

// ─────────────────────────── Types ──────────────────────────────────────────

export type LiquidityPoolType =
  | "PDH"
  | "PDL"
  | "SESSION_HIGH"
  | "SESSION_LOW"
  | "SWING_HIGH"
  | "SWING_LOW"
  | "ITH"
  | "ITL";

export type LiquiditySide = "UP" | "DOWN";

export interface LiquidityPoolCandidate {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly poolType: LiquidityPoolType;
  readonly side: LiquiditySide;
  readonly price: number;
  /** The bar time at which the pool level physically occurred. */
  readonly createdAtTime: Date;
  /**
   * The bar time at which a live system could first know this pool.
   * Invariant: knownAtTime >= createdAtTime (strictly enforced).
   */
  readonly knownAtTime: Date;
  /** The bar time at which the pool was breached/invalidated. Null = still active. */
  readonly invalidatedAtTime: Date | null;
  /** The candle ID that produced this candidate. */
  readonly sourceCandleId: string;
  /**
   * Trading-session date (profile calendar) of the bar at which the candidate became known.
   * Part of the idempotency key (instrument, timeframe, pool_type, price, session_date).
   */
  readonly sessionDate: string;
}

// ─────────────────────────── Helpers ─────────────────────────────────────────

function toCausalCandle(c: PersistedCandle): CausalCandle {
  return {
    id: c.id,
    openTime: c.openTime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  };
}

function assertKnownAtInvariant(candidate: LiquidityPoolCandidate): void {
  if (candidate.knownAtTime < candidate.createdAtTime) {
    throw new Error(
      `INVARIANT VIOLATION: knownAtTime (${candidate.knownAtTime.toISOString()}) ` +
        `is before createdAtTime (${candidate.createdAtTime.toISOString()}) ` +
        `for pool type ${candidate.poolType} @ price ${candidate.price}. ` +
        `This would introduce future leakage into the research dataset.`
    );
  }
}

// ─────────────────────────── Core Generator ──────────────────────────────────

/**
 * Walks the candle series bar by bar, maintaining causal state, and emits
 * candidates at the moment they become knowable to a live system.
 *
 * Returns the complete set of candidates including invalidation times.
 */
export function generateCandidates(
  candles: readonly PersistedCandle[],
  instrumentId: string,
  symbol: string,
  timeframe: string,
  pivotLength: number
): LiquidityPoolCandidate[] {
  const causalCandles = candles.map(toCausalCandle);
  const candidates: LiquidityPoolCandidate[] = [];

  // ── State machines ────────────────────────────────────────────────────────
  const sessionTracker = new IctSessionLevelTracker();

  // Tracks the latest confirmed swing highs/lows for ITH/ITL detection.
  // An ITH is a swing high that is strictly higher than the immediately preceding
  // confirmed swing high (and the one after it, known at confirmedAtTime of successor).
  const recentSwingHighs: Array<{ price: number; knownAtTime: Date; candleId: string }> = [];
  const recentSwingLows: Array<{ price: number; knownAtTime: Date; candleId: string }> = [];

  // Track active pool prices to detect breaches.
  // We keep the most recent active PDH, PDL, session high, session low.
  let activePdh: number | null = null;
  let activePdl: number | null = null;
  // Session whose PDH / PDL has already been registered (one registration per session, ever).
  let lastPdhSession: string | null = null;
  let lastPdlSession: string | null = null;
  let activeSessionHigh: number | null = null;
  let activeSessionHighCandleId: string | null = null;
  let activeSessionLow: number | null = null;
  let activeSessionLowCandleId: string | null = null;

  // Track active candidates by pool type for invalidation.
  // Maps pool_type + price → candidate index in `candidates` array.
  const activeByTypeAndPrice = new Map<string, number>();

  function invalidate(poolType: LiquidityPoolType, price: number, atTime: Date): void {
    const key = `${poolType}:${price}`;
    const idx = activeByTypeAndPrice.get(key);
    if (idx !== undefined) {
      // Mutate the invalidatedAtTime by rebuilding the candidate (immutable pattern).
      const existing = candidates[idx]!;
      candidates[idx] = { ...existing, invalidatedAtTime: atTime };
      activeByTypeAndPrice.delete(key);
    }
  }

  // Session date of the bar currently being processed (set each iteration, before any register).
  let barSessionDate = "";
  // One candidate per (pool_type, price, session_date): the in-memory mirror of the v2 UNIQUE
  // index. A level that already produced a candidate in this session -- breached or not -- is
  // never registered again in the same session.
  const registeredLevelSessions = new Set<string>();

  function registerCandidate(input: Omit<LiquidityPoolCandidate, "sessionDate">): boolean {
    const candidate: LiquidityPoolCandidate = { ...input, sessionDate: barSessionDate };
    assertKnownAtInvariant(candidate);
    const uniqueKey = `${candidate.poolType}:${candidate.price}:${candidate.sessionDate}`;
    if (registeredLevelSessions.has(uniqueKey)) return false;
    registeredLevelSessions.add(uniqueKey);
    const key = `${candidate.poolType}:${candidate.price}`;
    // A candidate at the same price+type that is still active gets invalidated first
    // (e.g. a level carried over from an earlier session at the same price).
    invalidate(candidate.poolType, candidate.price, candidate.knownAtTime);
    activeByTypeAndPrice.set(key, candidates.length);
    candidates.push(candidate);
    return true;
  }

  // ── Main bar-by-bar walk ───────────────────────────────────────────────────
  for (let i = 0; i < causalCandles.length; i++) {
    const bar = causalCandles[i]!;
    const persisted = candles[i]!;
    const barKnownAt = bar.openTime; // A bar is knowable at its open (after prior close).

    // ── 1. Invalidate breached pools ───────────────────────────────────────
    if (activePdh !== null && bar.high >= activePdh) {
      invalidate("PDH", activePdh, bar.openTime);
      activePdh = null;
    }
    if (activePdl !== null && bar.low <= activePdl) {
      invalidate("PDL", activePdl, bar.openTime);
      activePdl = null;
    }

    // ── 2. Session levels (PDH/PDL) ────────────────────────────────────────
    const sessionSnap = sessionTracker.processCandle(causalCandles, i);
    barSessionDate = sessionSnap.currentSessionDate;

    if (sessionSnap.levels) {
      const pdh = sessionSnap.levels.pdh;
      const pdl = sessionSnap.levels.pdl;
      const levelsSession = sessionSnap.levels.sessionDate;

      // Emit PDH/PDL exactly ONCE per session (first bar of the new session). The previous code
      // keyed on `pdh !== activePdh`, and `activePdh` is nulled on breach -- so after a breach the
      // SAME level was re-registered on the very next bar (and again, and again): one level-day
      // produced up to 1,725 rows (5m BANKNIFTY PDL: 104,749 rows for 191 level-days), and the
      // re-registering bar's own low was at/through the level by construction.
      if (levelsSession !== lastPdhSession && pdh > 0) {
        lastPdhSession = levelsSession;
        // The previous session's level is superseded by this session's level.
        if (activePdh !== null) {
          invalidate("PDH", activePdh, bar.openTime);
          activePdh = null;
        }
        // PDH becomes knowable at the open of the current session (first bar of new session).
        registerCandidate({
          instrumentId,
          symbol,
          timeframe,
          poolType: "PDH",
          side: "UP",
          price: pdh,
          createdAtTime: bar.openTime, // The prior session's high formed before open.
          knownAtTime: bar.openTime,   // Becomes knowable at the exact session open.
          invalidatedAtTime: null,
          sourceCandleId: persisted.id,
        });
        activePdh = pdh;
        // The registering bar may itself have breached the level; record that instead of leaving
        // the level "active" until the next bar.
        if (bar.high >= pdh) {
          invalidate("PDH", pdh, bar.openTime);
          activePdh = null;
        }
      }

      if (levelsSession !== lastPdlSession && pdl > 0) {
        lastPdlSession = levelsSession;
        if (activePdl !== null) {
          invalidate("PDL", activePdl, bar.openTime);
          activePdl = null;
        }
        registerCandidate({
          instrumentId,
          symbol,
          timeframe,
          poolType: "PDL",
          side: "DOWN",
          price: pdl,
          createdAtTime: bar.openTime,
          knownAtTime: bar.openTime,
          invalidatedAtTime: null,
          sourceCandleId: persisted.id,
        });
        activePdl = pdl;
        if (bar.low <= pdl) {
          invalidate("PDL", pdl, bar.openTime);
          activePdl = null;
        }
      }
    }

    // ── 3. Session High / Session Low (rolling intra-session extremes) ─────
    // SESSION_HIGH is emitted every time a new intra-session high is set.
    // The old SESSION_HIGH candidate is invalidated when a new one forms.
    const currentHigh = sessionSnap.currentSessionHigh;
    const currentLow = sessionSnap.currentSessionLow;

    if (currentHigh !== activeSessionHigh) {
      // Invalidate the old session high candidate if it exists.
      if (activeSessionHighCandleId !== null && activeSessionHigh !== null) {
        invalidate("SESSION_HIGH", activeSessionHigh, bar.openTime);
      }
      registerCandidate({
        instrumentId,
        symbol,
        timeframe,
        poolType: "SESSION_HIGH",
        side: "UP",
        price: currentHigh,
        createdAtTime: bar.openTime,
        knownAtTime: bar.openTime,
        invalidatedAtTime: null,
        sourceCandleId: persisted.id,
      });
      activeSessionHigh = currentHigh;
      activeSessionHighCandleId = persisted.id;
    }

    if (currentLow !== activeSessionLow) {
      if (activeSessionLowCandleId !== null && activeSessionLow !== null) {
        invalidate("SESSION_LOW", activeSessionLow, bar.openTime);
      }
      registerCandidate({
        instrumentId,
        symbol,
        timeframe,
        poolType: "SESSION_LOW",
        side: "DOWN",
        price: currentLow,
        createdAtTime: bar.openTime,
        knownAtTime: bar.openTime,
        invalidatedAtTime: null,
        sourceCandleId: persisted.id,
      });
      activeSessionLow = currentLow;
      activeSessionLowCandleId = persisted.id;
    }

    // ── 4. Swing High / Swing Low (causal fractal pivots) ─────────────────
    // A pivot at (i - pivotLength) is confirmed only when bar i closes.
    // knownAtTime = bar[i].openTime (i.e. the close of bar[i-1] confirmed it, visible at open of bar[i]).
    const pivots = findConfirmedPivotAt(causalCandles, i, pivotLength);

    if (pivots.high) {
      const swingHigh = pivots.high;
      registerCandidate({
        instrumentId,
        symbol,
        timeframe,
        poolType: "SWING_HIGH",
        side: "UP",
        price: swingHigh.price,
        createdAtTime: swingHigh.time,       // The bar when the high physically formed.
        knownAtTime: swingHigh.confirmedAtTime, // When the right wing confirmed it.
        invalidatedAtTime: null,
        sourceCandleId: persisted.id,
      });

      // ── 5. ITH: A swing high confirmed AND strictly higher than the immediately
      //       preceding confirmed swing high. ITH becomes knowable at the same time
      //       as the current swing high (the right wing's confirmedAtTime).
      if (
        recentSwingHighs.length >= 1 &&
        swingHigh.price > recentSwingHighs[recentSwingHighs.length - 1]!.price
      ) {
        registerCandidate({
          instrumentId,
          symbol,
          timeframe,
          poolType: "ITH",
          side: "UP",
          price: swingHigh.price,
          createdAtTime: swingHigh.time,
          knownAtTime: swingHigh.confirmedAtTime,
          invalidatedAtTime: null,
          sourceCandleId: persisted.id,
        });
      }

      recentSwingHighs.push({
        price: swingHigh.price,
        knownAtTime: swingHigh.confirmedAtTime,
        candleId: persisted.id,
      });
      if (recentSwingHighs.length > 10) recentSwingHighs.shift();
    }

    if (pivots.low) {
      const swingLow = pivots.low;
      registerCandidate({
        instrumentId,
        symbol,
        timeframe,
        poolType: "SWING_LOW",
        side: "DOWN",
        price: swingLow.price,
        createdAtTime: swingLow.time,
        knownAtTime: swingLow.confirmedAtTime,
        invalidatedAtTime: null,
        sourceCandleId: persisted.id,
      });

      if (
        recentSwingLows.length >= 1 &&
        swingLow.price < recentSwingLows[recentSwingLows.length - 1]!.price
      ) {
        registerCandidate({
          instrumentId,
          symbol,
          timeframe,
          poolType: "ITL",
          side: "DOWN",
          price: swingLow.price,
          createdAtTime: swingLow.time,
          knownAtTime: swingLow.confirmedAtTime,
          invalidatedAtTime: null,
          sourceCandleId: persisted.id,
        });
      }

      recentSwingLows.push({
        price: swingLow.price,
        knownAtTime: swingLow.confirmedAtTime,
        candleId: persisted.id,
      });
      if (recentSwingLows.length > 10) recentSwingLows.shift();
    }
  }

  return candidates;
}

// ─────────────────────────── DB Persistence ──────────────────────────────────

const CANDIDATE_COLUMNS_PER_ROW = 13;

/**
 * Builds the batched, idempotent INSERT. Rows are written with `candidate_version = 'v2-dedup'`
 * and conflict on the partial UNIQUE index from migration 132
 * (instrument_id, timeframe, pool_type, price, session_date) WHERE candidate_version = 'v2-dedup',
 * so re-running the generator never duplicates a level-day. Legacy ('v1-legacy') rows are untouched.
 */
export function buildCandidateInsert(
  batch: readonly LiquidityPoolCandidate[],
  runId: string
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const placeholders = batch.map((c, j) => {
    const base = j * CANDIDATE_COLUMNS_PER_ROW;
    values.push(
      c.instrumentId,       // ::uuid
      c.symbol,
      c.timeframe,
      c.poolType,
      c.side,
      c.price,
      c.createdAtTime,
      c.knownAtTime,
      c.invalidatedAtTime,
      c.sourceCandleId,     // ::uuid
      runId,
      c.sessionDate,        // ::date
      CANDIDATE_VERSION_CURRENT
    );
    return (
      `($${base + 1}::uuid,$${base + 2},$${base + 3},$${base + 4},` +
      `$${base + 5},$${base + 6},$${base + 7},$${base + 8},` +
      `$${base + 9},$${base + 10}::uuid,$${base + 11},$${base + 12}::date,$${base + 13})`
    );
  });

  const text =
    `INSERT INTO liquidity_pool_candidates
       (instrument_id, symbol, timeframe, pool_type, side, price,
        created_at_time, known_at_time, invalidated_at_time,
        source_candle_id, generation_run_id, session_date, candidate_version)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (instrument_id, timeframe, pool_type, price, session_date)
       WHERE candidate_version = '${CANDIDATE_VERSION_CURRENT}'
     DO NOTHING`;
  return { text, values };
}

async function persistCandidates(
  database: ReturnType<typeof createDatabasePool>,
  candidates: LiquidityPoolCandidate[],
  runId: string
): Promise<number> {
  let inserted = 0;
  const BATCH = 500;

  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    const { text, values } = buildCandidateInsert(batch, runId);
    const result = await database.query(text, values);
    // rowCount = rows actually inserted (conflicts skipped), not rows attempted.
    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

// ─────────────────────────── Entry point ─────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = requireOption(args, "symbol");
  const timeframe = requireOption(args, "timeframe");
  const pivotLength = Number(getOption(args, "pivot-length") ?? "5");
  const dryRun = args.includes("--dry-run");
  const runId = `phase1-${symbol}-${timeframe}-${Date.now()}`;

  const env = loadEnvironment();
  const database = createDatabasePool(env.DATABASE_URL);

  try {
    const instrumentRepo = new PostgresInstrumentRepository(database);
    const candleRepo = new PostgresCandleRepository(database);

    const instrument = await instrumentRepo.findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) throw new Error(`Unknown instrument: NSE:${symbol}`);

    const candles = await candleRepo.listCompleted(instrument.id, timeframe);
    console.info(JSON.stringify({
      level: "info",
      message: "Phase 1: starting candidate generation",
      symbol, timeframe, pivotLength, bars: candles.length, dryRun,
    }));

    if (candles.length === 0) {
      console.info(JSON.stringify({ level: "warn", message: "No completed candles found. Exiting.", symbol, timeframe }));
      return;
    }

    const candidates = generateCandidates(candles, instrument.id, symbol, timeframe, pivotLength);

    // Summary by pool type.
    const summary: Record<string, number> = {};
    for (const c of candidates) {
      summary[c.poolType] = (summary[c.poolType] ?? 0) + 1;
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Phase 1: generation complete",
      totalCandidates: candidates.length,
      byType: summary,
      dryRun,
    }));

    if (dryRun) {
      console.info(JSON.stringify({ level: "info", message: "Dry run — no rows written.", runId }));
      return;
    }

    const inserted = await persistCandidates(database, candidates, runId);
    console.info(JSON.stringify({
      level: "info",
      message: "Phase 1: candidates persisted",
      inserted, runId,
    }));
  } finally {
    await database.end();
  }
}

// Only run when executed directly as a CLI script, not when imported by tests.
if (process.argv[1]?.includes("generate-liquidity-candidates")) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: "error", message: String(err) }));
    process.exit(1);
  });
}
