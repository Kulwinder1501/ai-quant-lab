import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  createStandardNseSession,
  type MarketSession,
  type SessionCandle,
} from "../../modules/research/directional-v2/domain/session-calendar.js";
import { phase29ExcludedSpecialSessionMap } from "../../modules/research/directional-v2/domain/excluded-special-sessions.js";
import { auditDirectionalCandles } from "../../modules/research/directional-v2/application/audit-directional-candles.js";
import { generateDirectionalDataset } from "../../modules/research/directional-v2/application/generate-directional-dataset.js";
import {
  FROZEN_D2_MODEL,
  FROZEN_D2_PARENT_MANIFEST_HASH,
  FROZEN_D2_TARGET,
  runD2CostStudy,
  type D2ScoredDecision,
} from "../../modules/research/directional-v2/application/run-d2-cost-study.js";
import {
  chooseEntryTick,
  chooseExitTick,
  D2_HORIZON_MINUTES,
  D2_MAX_QUOTE_LAG_MS,
  D2_SIGNAL_TAIL_FRACTION,
  type D2PremiumTick,
  type D2Signal,
} from "../../modules/research/directional-v2/domain/d2-premium-cost-gate.js";

/**
 * D2 Opportunity Coverage Audit — Phase 29, read-only, no DB writes.
 *
 * Answers one question without touching returns or P&L: for the exact opportunities the frozen
 * D2 candidate would have acted on, was executable premium quoted within the existing 60-second
 * lag rule? It exists because two proxy measures were tried and rejected before it. A raw 5-minute
 * grid over the whole session (69 points/day) proxy showed no coverage difference between the
 * legacy and streamer collectors despite a ~6x tick-density gap — informative about density, but
 * over a grid nine times wider than anything D2 acts on, so a session could fail that audit for
 * gaps D2 never needed. A minimum-tick-count threshold was rejected outright: it would have been a
 * new free parameter invented after seeing nine sessions of data, exactly the kind of choice this
 * project's own governance rules exist to prevent. This audit needs neither, because D2 already
 * has a frozen, outcome-blind rule for what counts as covered: entry ask and exit bid each within
 * D2_MAX_QUOTE_LAG_MS of the moment they were needed.
 *
 * Physical ordering, enforced by the sequence of this file rather than by convention:
 *   1. Load index candles and the frozen D0/D1 dataset (no premium data exists in memory yet).
 *   2. Assert the historical training cutoff — see the note below.
 *   3. Fit the frozen model and tail thresholds; score every decision. Still no premium data.
 *   4. Freeze the tail candidates, resolve the (audit-only) no-overlap policy, canonical-sort and
 *      hash the resulting D2OpportunitySet. This is the point of no return: nothing after this
 *      line may change which opportunities exist.
 *   5. Only now load premium ticks, and only to check coverage against the frozen set — never to
 *      decide what belongs in it.
 *
 * ## The training cutoff is asserted, not derived independently
 *
 * `runD2CostStudy` (the frozen, unmodified production function) derives its training cutoff as
 * `premiumSessionDates[0]` — the historical fact that the first stored premium session was
 * 2026-08-12. This audit calls that same function and passes it the real premium session dates
 * (queried, not hard-coded) so the cutoff it computes is identical to production's. What this file
 * adds is `EXPECTED_D2_CUTOFF_SESSION`: an assertion that this historical fact still equals
 * 2026-08-12, so a later session's coverage failure can never silently move the boundary that
 * defines the training set. It deliberately is not written as a second, independent constant that
 * `runD2CostStudy` would need to be edited to match — that would create two sources of truth for
 * one frozen fact. The one carve-out: `premiumTicks` is passed as an empty array to this call, so
 * the frozen model, its tail thresholds and the scored decisions it returns are, by construction,
 * computed from index data and premium session *dates* only — never from a quote.
 *
 * ## Two resolvers, because the frozen protocol says "positions"
 *
 * The production `evaluateD2PremiumCostGate` resolver only advances `blockedUntilMs` on the branch
 * that finds an entry quote. A candidate with no quote inside the lag window does not suppress
 * anything, so premium availability partly determines which later candidates become opportunities.
 *
 * That looks like a defect, and it is not one. Three independent statements of the frozen protocol
 * all say *position*, never *opportunity* or *signal*: the phase document ("prevents overlapping
 * positions"), the frozen D2 manifest (`concurrency: "one-open-position-per-underlying"`), and the
 * skip counter itself (`overlappingPosition`). A position exists only once an entry fill exists, so
 * production implements the written rule faithfully. Changing it would not be a bug fix; it would
 * be a different experiment.
 *
 * So this audit reports both, and neither one silently:
 *
 * - `FROZEN_POSITION` mirrors production exactly. It is the semantic the running experiment uses,
 *   and therefore the one any qualification decision about the 60-session count must use. It
 *   cannot satisfy the freeze-then-load ordering above, because its traversal has to consult
 *   quotes to know what blocks. That inability is the finding, not a limitation of this tool.
 * - `PREMIUM_BLIND` commits a full 30-minute hold the moment a tail candidate is accepted,
 *   regardless of whether a quote ever turns up. It is the semantic a clean prospective study
 *   would use, it does satisfy the ordering, and it is the reference the hash is taken over. It is
 *   a *candidate* semantic for a future protocol (D2R), not a correction to this one.
 *
 * Divergence between the two counts is itself the measurement of how much premium availability is
 * steering the frozen experiment's opportunity set.
 */

const EXPECTED_D2_CUTOFF_SESSION = "2026-08-12";
const STREAMER_LAUNCH_SESSION = "2026-08-17"; // option-premium-tick-streamer.ts landed 2026-08-16.
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("../../../../../logs/directional-v2/", import.meta.url));
const UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

type CoverageStatus = "PASS" | "FAIL" | "NOT_TESTABLE_NO_OPPORTUNITIES" | "INCOMPLETE";
type FailureReason = "NO_ENTRY_ASK_WITHIN_60S" | "NO_EXIT_BID_WITHIN_60S";

interface D2Opportunity {
  readonly underlyingSymbol: string;
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly scheduledExitAt: Date;
  readonly side: "UP" | "DOWN";
  readonly score: number;
  readonly underlyingReferencePrice: number;
}

interface OpportunityCoverageResult {
  readonly opportunity: D2Opportunity;
  readonly entryCoveredWithin60s: boolean;
  readonly exitCoveredWithin60s: boolean;
  readonly failureReason: FailureReason | null;
  /**
   * Root cause, so "the vendor had no quote" is never assumed when the truth is "the quote was
   * eleven seconds outside the window" or "that contract was never subscribed that day". Those
   * call for completely different fixes and only one of them is a data-availability problem.
   */
  readonly diagnosis: CoverageDiagnosis | null;
}

interface CoverageDiagnosis {
  readonly wantedOptionType: "CE" | "PE";
  /** Whether any contract of the wanted type was quoted at all in that session. */
  readonly anyContractOfTypeObservedInSession: boolean;
  /** Ms from the moment a quote was needed to the next acceptable one, at any lag. Null if none. */
  readonly nearestAcceptableQuoteAfterMs: number | null;
  /** A near miss is a lag-window question; a long gap is a collection question. */
  readonly classification:
    | "NEAR_MISS_JUST_OUTSIDE_WINDOW"
    | "QUOTE_GAP_MINUTES"
    | "NO_QUOTE_FOR_REMAINDER_OF_SESSION"
    | "CONTRACT_TYPE_NEVER_OBSERVED_IN_SESSION";
}

interface SessionRow {
  readonly sessionDate: string;
  readonly collectorRegime: "legacy" | "streamer-v1";
  readonly candidates: number;
  readonly resolvedOpportunities: number;
  readonly entryWithin60s: number;
  readonly exitWithin60s: number;
  readonly fullyCovered: number;
  readonly coverageStatus: CoverageStatus;
  /** Same sessions under the D2R premium-blind resolver; divergence measures the steering effect. */
  readonly premiumBlindOpportunities: number;
}

function collectorRegimeFor(sessionDate: string): "legacy" | "streamer-v1" {
  return sessionDate < STREAMER_LAUNCH_SESSION ? "legacy" : "streamer-v1";
}

async function loadCandles(database: DatabasePool, symbol: string): Promise<SessionCandle[]> {
  const result = await database.query<{
    open_time: Date; close_time: Date; open: string; high: string; low: string; close: string; volume: string | null;
  }>(`
    SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume
    FROM candles c JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE AND c.source = 'fyers-api-v3'
    ORDER BY c.open_time ASC
  `, [symbol]);
  return result.rows.map((row) => ({
    openTime: new Date(row.open_time),
    closeTime: new Date(row.close_time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  }));
}

async function loadExpectedSessions(database: DatabasePool, candles: readonly SessionCandle[]): Promise<MarketSession[]> {
  if (candles.length === 0) return [];
  const toIstDate = (value: Date): string => new Date(value.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const firstDate = toIstDate(candles[0]!.openTime);
  const lastDate = toIstDate(candles[candles.length - 1]!.openTime);
  const result = await database.query<{ session_date: string }>(`
    SELECT day::date::text AS session_date
    FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS dates(day)
    WHERE EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5
      AND NOT EXISTS (SELECT 1 FROM nse_holidays holiday WHERE holiday.holiday_date = day::date)
    ORDER BY day ASC
  `, [firstDate, lastDate]);
  const specialSessions = phase29ExcludedSpecialSessionMap();
  return result.rows.filter((row) => !specialSessions.has(row.session_date)).map((row) => createStandardNseSession(row.session_date));
}

/** Cheap and premium-blind: which dates have any stored premium session, not what they contain. */
async function loadPremiumSessionDates(database: DatabasePool, symbol: string): Promise<string[]> {
  const result = await database.query<{ session_date: string }>(`
    SELECT DISTINCT (observed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS session_date
    FROM option_premium_ticks WHERE underlying_symbol = $1 AND provider = 'fyers-api-v3'
    ORDER BY 1
  `, [symbol]);
  return result.rows.map((row) => row.session_date);
}

/** The actual quotes. Loaded only after the opportunity set is frozen and hashed. */
async function loadPremiumTicks(database: DatabasePool, symbol: string): Promise<D2PremiumTick[]> {
  const result = await database.query<{
    underlying_symbol: string; observed_at: Date; expiry_date: string; strike_price: string;
    option_type: "CE" | "PE"; provider_symbol: string; bid: string | null; ask: string | null; underlying_value: string | null;
  }>(`
    SELECT underlying_symbol, observed_at, expiry_date::text, strike_price, option_type, provider_symbol,
           bid, ask, underlying_value
    FROM option_premium_ticks WHERE underlying_symbol = $1 AND provider = 'fyers-api-v3'
    ORDER BY observed_at ASC, provider_symbol ASC
  `, [symbol]);
  return result.rows.map((row) => ({
    underlyingSymbol: row.underlying_symbol,
    observedAt: new Date(row.observed_at),
    expiryDate: row.expiry_date,
    strikePrice: Number(row.strike_price),
    optionType: row.option_type,
    providerSymbol: row.provider_symbol,
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
    underlyingValue: row.underlying_value === null ? null : Number(row.underlying_value),
  }));
}

async function loadLotSize(database: DatabasePool, symbol: string): Promise<number> {
  const result = await database.query<{ lot_size: string | number }>(
    "SELECT lot_size FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1", [symbol],
  );
  const lotSize = Number(result.rows[0]?.lot_size);
  if (!Number.isInteger(lotSize) || lotSize <= 0) throw new Error(`Missing valid lot size for ${symbol}.`);
  return lotSize;
}

/**
 * Premium-blind by construction: reads only decisionAt/side/score, never a tick. A candidate
 * commits its full 30-minute hold the instant it is accepted, so whether a quote later turns up
 * for it cannot change which subsequent candidates are suppressed.
 */
function resolveOpportunities(underlyingSymbol: string, candidates: readonly D2ScoredDecision[]): D2Opportunity[] {
  const tail = [...candidates]
    .filter((candidate) => candidate.side !== null)
    .sort((left, right) => left.decisionAt.getTime() - right.decisionAt.getTime());
  const opportunities: D2Opportunity[] = [];
  let blockedUntilMs = Number.NEGATIVE_INFINITY;
  for (const candidate of tail) {
    if (candidate.decisionAt.getTime() < blockedUntilMs) continue;
    const scheduledExitAt = new Date(candidate.decisionAt.getTime() + D2_HORIZON_MINUTES * 60_000);
    blockedUntilMs = scheduledExitAt.getTime();
    opportunities.push({
      underlyingSymbol,
      sessionDate: candidate.sessionDate,
      decisionAt: candidate.decisionAt,
      scheduledExitAt,
      side: candidate.side!,
      score: candidate.score,
      underlyingReferencePrice: candidate.underlyingReferencePrice,
    });
  }
  return opportunities;
}

function signalFor(opportunity: D2Opportunity): D2Signal {
  return {
    sessionDate: opportunity.sessionDate,
    decisionAt: opportunity.decisionAt,
    dataThrough: new Date(opportunity.decisionAt.getTime() - 1),
    score: opportunity.score,
    side: opportunity.side,
    underlyingReferencePrice: opportunity.underlyingReferencePrice,
  };
}

/**
 * Why a lookup came back empty, measured rather than assumed.
 *
 * `neededAt` is the moment the quote was required; `predicate` is the same acceptability test the
 * frozen selector applies, so a "nearest acceptable quote" here means one the real selector would
 * have taken had it been inside the window.
 */
function diagnose(
  sessionTicks: readonly D2PremiumTick[],
  wantedOptionType: "CE" | "PE",
  neededAtMs: number,
  predicate: (tick: D2PremiumTick) => boolean,
): CoverageDiagnosis {
  const ofType = sessionTicks.filter((tick) => tick.optionType === wantedOptionType);
  if (ofType.length === 0) {
    return {
      wantedOptionType,
      anyContractOfTypeObservedInSession: false,
      nearestAcceptableQuoteAfterMs: null,
      classification: "CONTRACT_TYPE_NEVER_OBSERVED_IN_SESSION",
    };
  }
  let nearest: number | null = null;
  for (const tick of ofType) {
    const deltaMs = tick.observedAt.getTime() - neededAtMs;
    if (deltaMs >= 0 && predicate(tick) && (nearest === null || deltaMs < nearest)) nearest = deltaMs;
  }
  const classification = nearest === null
    ? "NO_QUOTE_FOR_REMAINDER_OF_SESSION"
    : nearest <= 2 * D2_MAX_QUOTE_LAG_MS
      ? "NEAR_MISS_JUST_OUTSIDE_WINDOW"
      : "QUOTE_GAP_MINUTES";
  return {
    wantedOptionType,
    anyContractOfTypeObservedInSession: true,
    nearestAcceptableQuoteAfterMs: nearest,
    classification,
  };
}

function checkCoverage(
  opportunity: D2Opportunity,
  ticks: readonly D2PremiumTick[],
  sessionTicks: readonly D2PremiumTick[],
): OpportunityCoverageResult {
  const wantedOptionType = opportunity.side === "UP" ? "CE" : "PE";
  const entry = chooseEntryTick(ticks, signalFor(opportunity));
  if (!entry) {
    return {
      opportunity,
      entryCoveredWithin60s: false,
      exitCoveredWithin60s: false,
      failureReason: "NO_ENTRY_ASK_WITHIN_60S",
      diagnosis: diagnose(
        sessionTicks, wantedOptionType, opportunity.decisionAt.getTime(),
        // Mirrors chooseEntryTick's acceptability test: right type, unexpired, both sides quoted.
        (tick) => tick.expiryDate >= opportunity.sessionDate
          && tick.ask !== null && tick.ask > 0 && tick.bid !== null && tick.bid > 0,
      ),
    };
  }
  const contractTicks = ticks.filter((tick) => tick.providerSymbol === entry.providerSymbol);
  const exit = chooseExitTick(contractTicks, opportunity.scheduledExitAt);
  if (!exit) {
    return {
      opportunity,
      entryCoveredWithin60s: true,
      exitCoveredWithin60s: false,
      failureReason: "NO_EXIT_BID_WITHIN_60S",
      // Scoped to the entered contract, because that is what the exit must use.
      diagnosis: diagnose(
        contractTicks, wantedOptionType, opportunity.scheduledExitAt.getTime(),
        (tick) => tick.bid !== null && tick.bid > 0,
      ),
    };
  }
  /*
   * The exit must price the contract that was entered, never a recomputed ATM. If spot has moved
   * 130 points in thirty minutes the current ATM strike is a different instrument, and pricing the
   * exit against it would silently replace a losing position with a fresh one. Production scopes
   * the exit lookup by `entry.providerSymbol`; this asserts the invariant rather than trusting it,
   * so an apparent exit gap can never actually be a contract-resolution bug.
   */
  if (exit.providerSymbol !== entry.providerSymbol) {
    throw new Error(
      `Contract identity broken for ${opportunity.underlyingSymbol} ${opportunity.sessionDate} `
      + `${opportunity.decisionAt.toISOString()}: entered ${entry.providerSymbol}, exited ${exit.providerSymbol}.`,
    );
  }
  return {
    opportunity,
    entryCoveredWithin60s: true,
    exitCoveredWithin60s: true,
    failureReason: null,
    diagnosis: null,
  };
}

/**
 * The frozen `position`-based traversal, mirroring `evaluateD2PremiumCostGate` exactly: a block is
 * taken only when an entry quote is found, so a candidate with no quote suppresses nothing.
 *
 * This necessarily consults premium data while deciding what counts as an opportunity, which is
 * why it is kept separate from the hashed premium-blind set rather than replacing it.
 */
function resolveFrozenPositionTraversal(
  underlyingSymbol: string,
  candidates: readonly D2ScoredDecision[],
  ticks: readonly D2PremiumTick[],
  ticksBySession: ReadonlyMap<string, readonly D2PremiumTick[]>,
): OpportunityCoverageResult[] {
  const tail = [...candidates]
    .filter((candidate) => candidate.side !== null)
    .sort((left, right) => left.decisionAt.getTime() - right.decisionAt.getTime());
  const results: OpportunityCoverageResult[] = [];
  let blockedUntilMs = Number.NEGATIVE_INFINITY;
  for (const candidate of tail) {
    if (candidate.decisionAt.getTime() < blockedUntilMs) continue;
    const opportunity: D2Opportunity = {
      underlyingSymbol,
      sessionDate: candidate.sessionDate,
      decisionAt: candidate.decisionAt,
      scheduledExitAt: new Date(candidate.decisionAt.getTime() + D2_HORIZON_MINUTES * 60_000),
      side: candidate.side!,
      score: candidate.score,
      underlyingReferencePrice: candidate.underlyingReferencePrice,
    };
    const result = checkCoverage(opportunity, ticks, ticksBySession.get(candidate.sessionDate) ?? []);
    results.push(result);
    // Production semantics: no entry quote means no position, so nothing is blocked.
    if (result.failureReason === "NO_ENTRY_ASK_WITHIN_60S") continue;
    blockedUntilMs = opportunity.scheduledExitAt.getTime();
  }
  return results;
}

function canonicalSortKey(opportunity: D2Opportunity): string {
  return `${opportunity.underlyingSymbol}|${opportunity.sessionDate}|${opportunity.decisionAt.toISOString()}|${opportunity.side}`;
}

function hashOpportunitySet(opportunities: readonly D2Opportunity[]): string {
  const canonical = [...opportunities]
    .sort((left, right) => canonicalSortKey(left).localeCompare(canonicalSortKey(right)))
    .map((opportunity) => ({
      underlyingSymbol: opportunity.underlyingSymbol,
      sessionDate: opportunity.sessionDate,
      decisionAt: opportunity.decisionAt.toISOString(),
      scheduledExitAt: opportunity.scheduledExitAt.toISOString(),
      side: opportunity.side,
      score: opportunity.score,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function main(): Promise<void> {
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  const now = new Date();
  try {
    const allCoverage: OpportunityCoverageResult[] = [];
    const allFrozenCoverage: OpportunityCoverageResult[] = [];
    const sessionRowsByUnderlying = new Map<string, SessionRow[]>();
    let opportunitySetHashParts: string[] = [];
    let trainingCutoffSession: string | null = null;
    const signalDiagnostics: Array<Record<string, unknown>> = [];

    const todayIst = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

    for (const symbol of UNDERLYINGS) {
      // --- Step 1: index data only. No premium ticks exist in memory yet. ---
      // Today is excluded before the strict candle audit runs: an in-progress session cannot
      // satisfy "one complete, aligned session", and production's own D2 CLI would throw on the
      // same audit if run mid-session. This is not a relaxation of the audit -- it is the same
      // reason today's coverage status is forced to INCOMPLETE below rather than measured.
      const allCandles = await loadCandles(database, symbol);
      const candles = allCandles.filter((candle) => (
        new Date(candle.openTime.getTime() + 330 * 60_000).toISOString().slice(0, 10) < todayIst
      ));
      const expectedSessions = (await loadExpectedSessions(database, candles))
        .filter((session) => session.sessionDate < todayIst);
      const audit = auditDirectionalCandles(symbol, candles, expectedSessions, {
        excludedSpecialSessions: phase29ExcludedSpecialSessionMap(),
      });
      if (!audit.ready) {
        throw new Error(`${symbol} failed its D2 index candle audit: ${audit.issues.map((issue) => issue.message).join(" | ")}`);
      }
      const dataset = generateDirectionalDataset(symbol, candles, { marketSessions: expectedSessions });

      // --- Step 2: assert the historical training-cutoff fact. Cheap, premium-blind. ---
      const storedPremiumSessionDates = await loadPremiumSessionDates(database, symbol);
      if (storedPremiumSessionDates.length === 0) throw new Error(`${symbol} has no stored premium sessions.`);
      // Today is reported as INCOMPLETE, never evaluated. Excluding it here also keeps it out of
      // the training/evaluation split, so a mid-session run and an after-close run of this audit
      // produce the same opportunity set for every completed session.
      const premiumSessionDates = storedPremiumSessionDates.filter((date) => date < todayIst);
      const actualCutoff = [...premiumSessionDates].sort()[0]!;
      if (actualCutoff !== EXPECTED_D2_CUTOFF_SESSION) {
        throw new Error(
          `${symbol}'s first stored premium session is ${actualCutoff}, not the frozen `
          + `${EXPECTED_D2_CUTOFF_SESSION}. The D2 training cutoff would move; stop and resolve this `
          + `before trusting any downstream coverage number.`,
        );
      }
      trainingCutoffSession = actualCutoff;

      // --- Step 3: fit the frozen model and score every decision. `premiumTicks: []` guarantees
      //     the model, thresholds and scored decisions below cannot depend on a quote. ---
      const scored = runD2CostStudy({
        underlyingSymbol: symbol,
        dataset,
        candles,
        premiumTicks: [],
        premiumSessionDates,
        lotSize: await loadLotSize(database, symbol),
      });

      // --- Step 4: freeze the opportunity set. This is the point of no return. ---
      const opportunities = resolveOpportunities(symbol, scored.scoredDecisions);
      opportunitySetHashParts.push(hashOpportunitySet(opportunities));

      /*
       * Signal-side diagnostic, from model scores only -- never `realizedUnderlyingReturnBps`,
       * which sits on the same rows and is deliberately not read here.
       *
       * This exists because the first run of this audit returned 104 opportunities of which every
       * single one was DOWN. A tail rule that is symmetric by construction (10% of the training
       * score distribution at each end) producing a one-sided evaluation set is a claim worth
       * evidencing rather than asserting, so the thresholds and the evaluation score range are
       * reported next to the counts.
       */
      const evaluationScores = scored.scoredDecisions.map((decision) => decision.score).sort((a, b) => a - b);
      signalDiagnostics.push({
        underlyingSymbol: symbol,
        trainingFirstSession: scored.model.trainingFirstSession,
        trainingLastSession: scored.model.trainingLastSession,
        trainingSampleCount: scored.model.trainingSampleCount,
        lowerScoreThreshold: scored.model.lowerScoreThreshold,
        upperScoreThreshold: scored.model.upperScoreThreshold,
        evaluatedDecisions: evaluationScores.length,
        evaluationScoreMin: evaluationScores[0] ?? null,
        evaluationScoreMedian: evaluationScores[Math.floor(evaluationScores.length / 2)] ?? null,
        evaluationScoreMax: evaluationScores.at(-1) ?? null,
        tailCandidatesDown: scored.scoredDecisions.filter((decision) => decision.side === "DOWN").length,
        tailCandidatesUp: scored.scoredDecisions.filter((decision) => decision.side === "UP").length,
        noSignal: scored.scoredDecisions.filter((decision) => decision.side === null).length,
      });

      // --- Step 5: only now, premium ticks. ---
      const ticks = await loadPremiumTicks(database, symbol);
      const ticksBySession = new Map<string, D2PremiumTick[]>();
      for (const tick of ticks) {
        const sessionDate = new Date(tick.observedAt.getTime() + 330 * 60_000).toISOString().slice(0, 10);
        const list = ticksBySession.get(sessionDate) ?? [];
        list.push(tick);
        ticksBySession.set(sessionDate, list);
      }

      // The premium-blind reference set, whose hash is the one recorded above.
      const coverage = opportunities.map((opportunity) => checkCoverage(
        opportunity, ticks, ticksBySession.get(opportunity.sessionDate) ?? [],
      ));
      allCoverage.push(...coverage);

      // The frozen `position` traversal — the semantic the running experiment actually uses, and
      // therefore the one the 60-session qualification count must be read from.
      const frozenCoverage = resolveFrozenPositionTraversal(symbol, scored.scoredDecisions, ticks, ticksBySession);
      allFrozenCoverage.push(...frozenCoverage);

      const bySession = new Map<string, OpportunityCoverageResult[]>();
      for (const result of frozenCoverage) {
        const list = bySession.get(result.opportunity.sessionDate) ?? [];
        list.push(result);
        bySession.set(result.opportunity.sessionDate, list);
      }
      const blindBySession = new Map<string, OpportunityCoverageResult[]>();
      for (const result of coverage) {
        const list = blindBySession.get(result.opportunity.sessionDate) ?? [];
        list.push(result);
        blindBySession.set(result.opportunity.sessionDate, list);
      }
      const rows: SessionRow[] = storedPremiumSessionDates.map((sessionDate) => {
        if (sessionDate >= todayIst) {
          return {
            sessionDate,
            collectorRegime: collectorRegimeFor(sessionDate),
            candidates: 0,
            resolvedOpportunities: 0,
            entryWithin60s: 0,
            exitWithin60s: 0,
            fullyCovered: 0,
            coverageStatus: "INCOMPLETE",
            premiumBlindOpportunities: 0,
          };
        }
        const results = bySession.get(sessionDate) ?? [];
        const candidateCount = scored.scoredDecisions.filter((d) => d.sessionDate === sessionDate && d.side !== null).length;
        const entryOk = results.filter((r) => r.entryCoveredWithin60s).length;
        const exitOk = results.filter((r) => r.exitCoveredWithin60s).length;
        const fullyCovered = results.filter((r) => r.entryCoveredWithin60s && r.exitCoveredWithin60s).length;
        const lastOpportunity = results.at(-1)?.opportunity;
        const auditRequiredThroughMs = lastOpportunity
          ? lastOpportunity.scheduledExitAt.getTime() + D2_MAX_QUOTE_LAG_MS
          : null;
        let coverageStatus: CoverageStatus;
        if (auditRequiredThroughMs !== null && now.getTime() < auditRequiredThroughMs) {
          coverageStatus = "INCOMPLETE";
        } else if (results.length === 0) {
          coverageStatus = "NOT_TESTABLE_NO_OPPORTUNITIES";
        } else if (fullyCovered === results.length) {
          coverageStatus = "PASS";
        } else {
          coverageStatus = "FAIL";
        }
        return {
          sessionDate,
          collectorRegime: collectorRegimeFor(sessionDate),
          candidates: candidateCount,
          resolvedOpportunities: results.length,
          entryWithin60s: entryOk,
          exitWithin60s: exitOk,
          fullyCovered,
          coverageStatus,
          premiumBlindOpportunities: (blindBySession.get(sessionDate) ?? []).length,
        };
      });
      sessionRowsByUnderlying.set(symbol, rows);
    }

    const manifest = {
      parentManifestHash: FROZEN_D2_PARENT_MANIFEST_HASH,
      modelPolicyVersion: `${FROZEN_D2_TARGET} / ${FROZEN_D2_MODEL}`,
      tailPolicyVersion: `signal-tail-fraction-${D2_SIGNAL_TAIL_FRACTION}`,
      overlapPolicyVersion: "premium-blind-planned-30m-hold-v1-AUDIT-ONLY",
      contractSelectionPolicyVersion: "d2-frozen-nearest-expiry-atm-tightest-spread-v1 (chooseEntryTick/chooseExitTick, unmodified)",
      trainingCutoffSession,
      quoteLagMs: D2_MAX_QUOTE_LAG_MS,
      opportunitySetHash: createHash("sha256").update(opportunitySetHashParts.join("|")).digest("hex"),
      generatedAt: now.toISOString(),
      knownDiscrepancy:
        "The production overlap resolver in evaluateD2PremiumCostGate only advances blockedUntilMs "
        + "when an entry quote is found, so a missing entry quote does not suppress later candidates "
        + "the way a missing exit quote does. This audit's overlapPolicyVersion is deliberately "
        + "symmetric and premium-blind instead, so its opportunity counts will not exactly match a "
        + "production run's signalCount / resolvedQuotePairCount. That is the finding, not a bug in "
        + "this tool.",
    };

    console.info("================================================================================");
    console.info("D2 OPPORTUNITY COVERAGE AUDIT — read-only, no returns or P&L loaded");
    console.info("================================================================================");
    console.info(JSON.stringify(manifest, null, 2));
    for (const symbol of UNDERLYINGS) {
      console.info(`\n${symbol}`);
      console.info("session      | regime      | cands | frozen | blind | entry<=60s | exit<=60s | covered | status");
      for (const row of sessionRowsByUnderlying.get(symbol) ?? []) {
        console.info(
          `${row.sessionDate}  | ${row.collectorRegime.padEnd(11)} | ${String(row.candidates).padStart(5)} `
          + `| ${String(row.resolvedOpportunities).padStart(6)} | ${String(row.premiumBlindOpportunities).padStart(5)} `
          + `| ${String(row.entryWithin60s).padStart(10)} | ${String(row.exitWithin60s).padStart(9)} `
          + `| ${String(row.fullyCovered).padStart(7)} | ${row.coverageStatus}`,
        );
      }
    }

    const failures = allFrozenCoverage.filter((result) => result.failureReason !== null);
    console.info(
      `\nFROZEN (position) semantics — the running experiment: `
      + `${allFrozenCoverage.length} opportunities, ${failures.length} uncovered.`,
    );
    console.info(
      `PREMIUM_BLIND (D2R candidate) semantics: ${allCoverage.length} opportunities, `
      + `${allCoverage.filter((result) => result.failureReason !== null).length} uncovered.`,
    );

    const byClassification = failures.reduce<Record<string, number>>((acc, failure) => {
      const key = `${failure.failureReason} / ${failure.diagnosis?.classification ?? "UNKNOWN"}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    console.info("\nCoverage-failure root causes (frozen semantics):");
    for (const [key, count] of Object.entries(byClassification).sort((left, right) => right[1] - left[1])) {
      console.info(`  ${String(count).padStart(3)}  ${key}`);
    }
    const nearestLags = failures
      .map((failure) => failure.diagnosis?.nearestAcceptableQuoteAfterMs)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    if (nearestLags.length > 0) {
      console.info(
        `  nearest acceptable quote after the needed moment: min ${nearestLags[0]}ms, `
        + `median ${nearestLags[Math.floor(nearestLags.length / 2)]}ms, max ${nearestLags.at(-1)}ms`,
      );
    }

    const outputDir = resolve(DEFAULT_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const outputPath = resolve(outputDir, `d2-opportunity-coverage-audit-${timestamp}.json`);
    const sideCounts = allCoverage.reduce<Record<string, { total: number; failed: number }>>((acc, result) => {
      const entry = acc[result.opportunity.side] ?? { total: 0, failed: 0 };
      entry.total += 1;
      if (result.failureReason !== null) entry.failed += 1;
      acc[result.opportunity.side] = entry;
      return acc;
    }, {});
    console.info(`\nCoverage by side: ${JSON.stringify(sideCounts)}`);
    console.info("\nSIGNAL-SIDE DIAGNOSTIC (model scores only; no realized returns read)");
    console.info(JSON.stringify(signalDiagnostics, null, 2));

    await writeFile(outputPath, JSON.stringify({
      manifest,
      sessions: Object.fromEntries(sessionRowsByUnderlying),
      sideCounts,
      frozenPositionOpportunities: allFrozenCoverage.map((result) => ({
        underlyingSymbol: result.opportunity.underlyingSymbol,
        sessionDate: result.opportunity.sessionDate,
        decisionAt: result.opportunity.decisionAt.toISOString(),
        scheduledExitAt: result.opportunity.scheduledExitAt.toISOString(),
        side: result.opportunity.side,
        entryCoveredWithin60s: result.entryCoveredWithin60s,
        exitCoveredWithin60s: result.exitCoveredWithin60s,
        failureReason: result.failureReason,
        diagnosis: result.diagnosis,
      })),
      premiumBlindOpportunities: allCoverage.map((result) => ({
        underlyingSymbol: result.opportunity.underlyingSymbol,
        sessionDate: result.opportunity.sessionDate,
        decisionAt: result.opportunity.decisionAt.toISOString(),
        scheduledExitAt: result.opportunity.scheduledExitAt.toISOString(),
        side: result.opportunity.side,
        entryCoveredWithin60s: result.entryCoveredWithin60s,
        exitCoveredWithin60s: result.exitCoveredWithin60s,
        failureReason: result.failureReason,
      })),
    }, null, 2), "utf8");
    console.info(`\nAudit artifact written to ${outputPath}`);
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
