import "dotenv/config";
import {
  RISK_FREE_RATE,
  impliedVolatilityFromPremium,
  midPriceForIv,
  nearestStrike,
  yearsToExpiry,
  type OptionType,
} from "@ai-quant-lab/pricing";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { calculateEntryFees, calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";
import { mapIdeaToOptionBuyerFill } from "../../modules/paper-trading/domain/option-buyer-fill.js";
import { decideOptionBuyerObservedExit, type ObservedPremiumSample } from "../../modules/paper-trading/domain/option-mark-to-market.js";
import type { OptionExpiryCalendar } from "../../modules/market-data/domain/option-expiry-calendar.js";
import { premiumCoverageExpiries } from "../../modules/market-data/domain/atm-premium-contracts.js";
import { MINIMUM_DAYS_TO_EXPIRY } from "../../modules/paper-trading/application/prepare-option-entry.js";
import type { PaperTrade } from "../../modules/paper-trading/domain/paper-trading.js";

/**
 * Cost-adjusted re-grading of Brain V2.2's native-pipeline (P5-P10) approvals.
 *
 * `brain_v22_approval_grading.py` (re-run 2026-09-29 against 110 accumulated approved decisions,
 * -2.57 pts/approval, 37.5% target-hit rate) measures raw underlying index/futures points with
 * *zero* cost model of any kind -- it does not even consume `decision-pipeline-input.ts`'s
 * `placeholderCostBps`, since P13's `canonicalDecisionPipelineOutcome` only reads the thesis
 * stage. This script is the honest follow-up: it reuses that same resolution query (same-day,
 * same-bar-stop-first) to get each approval's outcome and points, then asks the separate,
 * harder question -- what would a real option buyer actually have realised, in premium terms,
 * after the real Zerodha/NSE fee schedule (`brokerage-calculator.ts`) and the real bid/ask spread
 * (`option_premium_ticks`)?
 *
 * ## Why this is a second, independent barrier scan, not a re-use of the raw grading's resolution time
 *
 * The raw grading resolves the bracket against the *underlying's* 5m candles. Converting that
 * resolution instant into a premium P&L would silently assume the option moved in lockstep with
 * the underlying, which is exactly the assumption P10's docstring says does not hold ("no
 * premium-space repricing... deferred") and which the project's own memory
 * (`premium-target-unreachable-at-index-target`) found false at the ATM strike specifically. So
 * the stop/target are repriced into premium space with `mapIdeaToOptionBuyerFill` (the same
 * reviewed function `prepare-option-entry.ts` and `run-atm-vs-itm-strike-backtest.ts` use), and
 * `decideOptionBuyerObservedExit` walks the real, densely-collected premium ticks
 * (`option_premium_ticks`, 15-30s polling) forward from decision time to find the first bid that
 * actually crosses either premium barrier -- same-day only, matching the raw grading's own
 * horizon. A day that never crosses either barrier is TIMEOUT, exiting at the last available bid
 * that day, the same convention `brain_v22_approval_grading.py` uses for the underlying case.
 *
 * ## Contract selection
 *
 * `nearestStrike(entry, strikeStep)` for ATM (V1's live convention -- see `option-buyer-fill.ts`),
 * CE for a LONG idea / PE for a SHORT idea (`mapIdeaToOptionBuyerFill`'s own convention).
 *
 * Expiry is the **front** (nearest unexpired) listed expiry, via `atm-premium-contracts.ts`'s own
 * `premiumCoverageExpiries` -- NOT V1's real live floor (`prepare-option-entry.ts`'s
 * `MINIMUM_DAYS_TO_EXPIRY = 2`, "tradable" expiry). This was verified against the data, not
 * assumed: `collect-option-premium-ticks.ts`'s dense ATM poller (`selectAtmPremiumContracts`)
 * only ever asks the chain snapshot for its *first* listed expiry -- the "tradable" expiry is
 * collected in addition only when a real V1 paper trade already has one open, which V2.2's
 * shadow decisions never do. So the front expiry is what the real premium-tick data actually
 * covers; picking the >=2-day-out "tradable" expiry here found zero fillable entry quotes on
 * 118/118 approvals in a first pass, because nothing was ever collected there. This means some
 * approvals get repriced against a same-day-expiring (0 DTE) contract when the front expiry is
 * that close -- nearly all gamma/theta, and a real weakness of using real data rather than a
 * choice this script prefers; it is reported, not hidden (see the per-approval `expiryDate` vs
 * `decisionAt` gap in the detail table).
 *
 * ## Coverage is reported, not fudged
 *
 * Some approvals will have no fillable entry tick within the freshness window, no listed expiry
 * far enough out, or a `mapIdeaToOptionBuyerFill` risk-reward-distortion refusal. Those are
 * counted and reported as `NO_ENTRY_QUOTE` / `NO_EXPIRY` / `GEOMETRY_REFUSED` / `NO_EXIT_TICKS`,
 * never silently substituted with a modelled fallback.
 */

const APPROVAL_PATTERN =
  /APPROVED (LONG|SHORT) entry=([\d.]+) stop=([\d.]+) target=([\d.]+)/g;

/** How stale an entry ask may be. Wider than live's 2-minute execution freshness because these
 * are 5m/15m research decisions, not live order placement -- but still bounded, so a fill many
 * minutes away from the decision is refused rather than silently accepted. */
const ENTRY_FRESHNESS_MS = 5 * 60 * 1000;

const CANDLE_QUERY = `
  SELECT c.open_time, c.high, c.low, c.close
  FROM candles c
  JOIN instruments i ON i.id = c.instrument_id
  WHERE i.symbol = $1 AND c.timeframe = '5m'
    AND c.open_time > $2
    AND (c.open_time AT TIME ZONE 'Asia/Kolkata')::date = ($2 AT TIME ZONE 'Asia/Kolkata')::date
  ORDER BY c.open_time ASC;
`;

const APPROVALS_QUERY = `
  SELECT comparison_key, v2_outcome
  FROM differential_observations
  WHERE producer_id = 'native-pipeline' AND v2_outcome LIKE 'APPROVED%'
  ORDER BY comparison_key;
`;

interface RawApproval {
  instrument: string;
  timeframe: string;
  decisionAt: Date;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
}

interface RawGrade {
  outcome: "STOP" | "TARGET" | "TIMEOUT";
  points: number;
  resolvedAt: Date | null;
}

interface CostAdjustedGrade {
  status: "FILLED" | "NO_EXPIRY" | "NO_ENTRY_QUOTE" | "GEOMETRY_REFUSED" | "NO_EXIT_TICKS";
  detail?: string;
  strike?: number;
  optionType?: OptionType;
  expiryDate?: Date;
  entryPremium?: number;
  exitPremium?: number;
  exitReason?: "STOP_LOSS" | "TARGET" | "TIMEOUT";
  quantity?: number;
  entryFees?: number;
  exitFees?: number;
  grossPnl?: number;
  netPnl?: number;
  /** One-way, fees-only, as bps of PREMIUM turnover: (entryFees+exitFees) / (2 * premiumTurnover) * 10000.
   * The natural "options cost" framing, but NOT the unit decision-pipeline-input.ts's costBps uses. */
  effectiveCostBpsOfPremium?: number;
  /** One-way, fees-only, as bps of UNDERLYING notional: (entryFees+exitFees) / (2 * quantity * underlyingEntry) * 10000.
   * THIS is the same basis as `edge-assessor.ts`'s `roundTripCostR`, which charges costBps against
   * `geometry.entryReference` (the underlying price) -- see the module docstring's "costBps replacement"
   * section. It excludes the bid/ask spread cost (already inside netPnl via ask-in/bid-out), so it is a
   * conservative floor on the real underlying-notional-equivalent cost, not the whole of it. */
  effectiveCostBpsOfUnderlying?: number;
  /** One-way, as bps of UNDERLYING notional, of fees PLUS the round-trip bid/ask spread cost. The
   * most complete real-cost figure this script can derive on this basis, and the one actually used
   * to replace decision-pipeline-input.ts's placeholder. Null when an exit mid could not be solved
   * (no ask observed at the exit instant). */
  totalCostBpsOfUnderlying?: number;
}

interface RawTickRow {
  observed_at: Date;
  bid: string | null;
  ask: string | null;
  underlying_value: string | null;
}
interface TickRow {
  observed_at: Date;
  bid: number | null;
  ask: number | null;
  underlying_value: number | null;
}
function toTickRow(row: RawTickRow): TickRow {
  const toNum = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    observed_at: row.observed_at,
    bid: toNum(row.bid),
    ask: toNum(row.ask),
    underlying_value: toNum(row.underlying_value),
  };
}

function parseApprovals(comparisonKey: string, v2Outcome: string): RawApproval[] {
  const parts = comparisonKey.split("@");
  const instrument = parts[0]!;
  const timeframe = parts[1]!;
  const decisionAt = new Date(parts[2]!);
  const approvals: RawApproval[] = [];
  for (const match of v2Outcome.matchAll(APPROVAL_PATTERN)) {
    approvals.push({
      instrument,
      timeframe,
      decisionAt,
      side: match[1] as "LONG" | "SHORT",
      entry: Number(match[2]),
      stop: Number(match[3]),
      target: Number(match[4]),
    });
  }
  return approvals;
}

async function gradeRaw(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: { open_time: Date; high: string; low: string; close: string }[] }> },
  approval: RawApproval,
): Promise<RawGrade> {
  const result = await database.query(CANDLE_QUERY, [approval.instrument, approval.decisionAt]);
  const candles = result.rows;
  const { side, entry, stop, target } = approval;
  for (const candle of candles) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const hitStop = side === "LONG" ? low <= stop : high >= stop;
    const hitTarget = side === "LONG" ? high >= target : low <= target;
    if (hitStop) {
      return {
        outcome: "STOP",
        points: side === "LONG" ? stop - entry : entry - stop,
        resolvedAt: candle.open_time,
      };
    }
    if (hitTarget) {
      return {
        outcome: "TARGET",
        points: side === "LONG" ? target - entry : entry - target,
        resolvedAt: candle.open_time,
      };
    }
  }
  const lastClose = candles.length > 0 ? Number(candles[candles.length - 1]!.close) : entry;
  return {
    outcome: "TIMEOUT",
    points: side === "LONG" ? lastClose - entry : entry - lastClose,
    resolvedAt: null,
  };
}

async function fetchExpiryCalendar(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: { expiry_date: Date; expiry_kind: string; observed_at: Date }[] }> },
  underlyingSymbol: string,
  asOf: Date,
): Promise<OptionExpiryCalendar | null> {
  const latest = await database.query(
    `SELECT MAX(observed_at) AS observed_at FROM option_expiry_calendar
     WHERE underlying_symbol = $1 AND observed_at <= $2`,
    [underlyingSymbol, asOf],
  );
  const observedAt = (latest.rows[0] as unknown as { observed_at: Date | null })?.observed_at;
  if (!observedAt) return null;
  const rows = await database.query(
    `SELECT expiry_date, expiry_kind, observed_at FROM option_expiry_calendar
     WHERE underlying_symbol = $1 AND observed_at = $2`,
    [underlyingSymbol, observedAt],
  );
  if (rows.rows.length === 0) return null;
  return {
    underlyingSymbol,
    provider: "stored",
    observedAt,
    expiries: rows.rows.map((r) => ({
      expiryDate: new Date(r.expiry_date),
      expiryKind: r.expiry_kind as "WEEKLY" | "MONTHLY",
    })),
  };
}

async function fetchEntryTick(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: RawTickRow[] }> },
  args: { symbol: string; expiryDate: Date; strike: number; optionType: OptionType; asOf: Date },
): Promise<TickRow | null> {
  const result = await database.query(
    `
    SELECT observed_at, bid, ask, underlying_value
    FROM option_premium_ticks
    WHERE underlying_symbol = $1 AND expiry_date = $2::date AND strike_price = $3 AND option_type = $4
      AND observed_at <= $5 AND observed_at >= $5::timestamptz - interval '5 minutes'
      AND ask IS NOT NULL AND ask > 0
    ORDER BY observed_at DESC
    LIMIT 1
    `,
    [args.symbol, args.expiryDate.toISOString().slice(0, 10), args.strike, args.optionType, args.asOf],
  );
  const row = result.rows[0];
  return row ? toTickRow(row) : null;
}

async function fetchTicksSameDay(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: RawTickRow[] }> },
  args: { symbol: string; expiryDate: Date; strike: number; optionType: OptionType; from: Date },
): Promise<TickRow[]> {
  const result = await database.query(
    `
    SELECT observed_at, bid, ask, underlying_value
    FROM option_premium_ticks
    WHERE underlying_symbol = $1 AND expiry_date = $2::date AND strike_price = $3 AND option_type = $4
      AND observed_at > $5
      AND (observed_at AT TIME ZONE 'Asia/Kolkata')::date = ($5 AT TIME ZONE 'Asia/Kolkata')::date
    ORDER BY observed_at ASC
    `,
    [args.symbol, args.expiryDate.toISOString().slice(0, 10), args.strike, args.optionType, args.from],
  );
  return result.rows.map(toTickRow);
}

async function costAdjustedReprice(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> },
  approval: RawApproval,
  strikeStep: number,
  lotSize: number,
): Promise<CostAdjustedGrade> {
  const optionType: OptionType = approval.side === "LONG" ? "CE" : "PE";
  const strike = nearestStrike(approval.entry, strikeStep);

  const calendar = await fetchExpiryCalendar(database, approval.instrument, approval.decisionAt);
  // Front expiry, matching what the dense premium collector actually covers -- see the module
  // docstring's "Contract selection" section for why this is not the >=2-day "tradable" floor.
  const coverageKeys = premiumCoverageExpiries(calendar, approval.decisionAt, MINIMUM_DAYS_TO_EXPIRY);
  const frontKey = coverageKeys[0];
  const frontEntry = frontKey === undefined
    ? undefined
    : calendar?.expiries.find((e) => e.expiryDate.toISOString().slice(0, 10) === frontKey);
  if (!frontEntry) {
    return {
      status: "NO_EXPIRY",
      detail: calendar === null
        ? `No option-expiry calendar collected for ${approval.instrument} at or before ${approval.decisionAt.toISOString()}.`
        : `${approval.instrument} lists no unexpired front expiry as of ${approval.decisionAt.toISOString()}.`,
      strike, optionType,
    };
  }
  const expiryDate = frontEntry.expiryDate;

  const entryTick = await fetchEntryTick(database, {
    symbol: approval.instrument,
    expiryDate,
    strike,
    optionType,
    asOf: approval.decisionAt,
  });
  if (!entryTick || entryTick.ask === null || entryTick.ask <= 0) {
    return {
      status: "NO_ENTRY_QUOTE",
      detail: `no fillable ${approval.instrument} ${strike}${optionType} ask within ${ENTRY_FRESHNESS_MS / 60000}min before decision`,
      strike, optionType, expiryDate,
    };
  }

  const mid = midPriceForIv(entryTick.bid, entryTick.ask);
  const spot = entryTick.underlying_value ?? approval.entry;
  const T = yearsToExpiry(entryTick.observed_at, expiryDate);
  const ivResult = mid !== null && spot > 0
    ? impliedVolatilityFromPremium({
      spot, strike, timeToExpiryYears: T, riskFreeRate: RISK_FREE_RATE, optionType, premium: mid,
    })
    : { measurable: false as const };
  const solvedIv = ivResult.measurable ? ivResult.impliedVolatility : 0.12; // fallback matches prepare-option-entry.ts's own FALLBACK_IV

  let mapped: ReturnType<typeof mapIdeaToOptionBuyerFill>;
  try {
    mapped = mapIdeaToOptionBuyerFill({
      ideaSide: approval.side,
      underlyingEntry: approval.entry,
      underlyingStop: approval.stop,
      underlyingTarget: approval.target,
      impliedVolatility: solvedIv,
      expiryDate,
      strikeStep,
      strikeOverride: strike,
      now: entryTick.observed_at,
      observedFill: {
        premium: entryTick.ask,
        impliedVolatility: solvedIv,
        source: "OPTION_PREMIUM_TICK_ASK",
        bid: entryTick.bid,
      },
    });
  } catch (error) {
    return {
      status: "GEOMETRY_REFUSED",
      detail: error instanceof Error ? error.message : String(error),
      strike, optionType, expiryDate,
    };
  }

  const quantity = lotSize; // one lot -- consistent per-approval unit, not a sized risk decision
  const entryFees = calculateEntryFees(mapped.fillPremium, quantity).total;

  const ticks = await fetchTicksSameDay(database, {
    symbol: approval.instrument, expiryDate, strike, optionType, from: approval.decisionAt,
  });
  const samples: ObservedPremiumSample[] = ticks.map((t) => ({
    observedAt: t.observed_at, bid: t.bid, underlyingValue: t.underlying_value,
  }));

  const mockTrade = {
    status: "OPEN", side: "LONG", stopLoss: mapped.stopPremium, targetPrice: mapped.targetPremium,
  } as unknown as PaperTrade;
  const barrier = decideOptionBuyerObservedExit(mockTrade, samples);

  let exitPremium: number;
  let exitReason: "STOP_LOSS" | "TARGET" | "TIMEOUT";
  let exitObservedAt: Date;
  if (barrier) {
    exitPremium = barrier.exitPrice;
    exitReason = barrier.reason;
    exitObservedAt = barrier.observedAt;
  } else {
    const lastSample = [...samples].reverse().find((s) => s.bid !== null && s.bid > 0);
    if (lastSample === undefined) {
      return {
        status: "NO_EXIT_TICKS",
        detail: `no positive bid observed same-day for ${approval.instrument} ${strike}${optionType} ${expiryDate.toISOString().slice(0, 10)}`,
        strike, optionType, expiryDate, entryPremium: mapped.fillPremium, quantity, entryFees,
      };
    }
    exitPremium = lastSample.bid!;
    exitReason = "TIMEOUT";
    exitObservedAt = lastSample.observedAt;
  }

  const exitFees = calculateExitFees(exitPremium, quantity).total;
  const grossPnl = (exitPremium - mapped.fillPremium) * quantity;
  const netPnl = grossPnl - entryFees - exitFees;
  const premiumTurnover = mapped.fillPremium * quantity;
  const underlyingNotional = approval.entry * quantity;
  const effectiveCostBpsOfPremium = premiumTurnover > 0
    ? ((entryFees + exitFees) / (2 * premiumTurnover)) * 10_000
    : undefined;
  const effectiveCostBpsOfUnderlying = underlyingNotional > 0
    ? ((entryFees + exitFees) / (2 * underlyingNotional)) * 10_000
    : undefined;

  // Round-trip spread cost: what crossing the book (ask-in / bid-out) cost versus a hypothetical
  // frictionless mid-to-mid fill. Entry's own mid was already solved for IV; the exit tick's ask is
  // looked up from the same fetched series to solve the exit mid the same way. This is the dominant
  // real options cost this project has repeatedly found (e.g. `premium-target-unreachable-at-index-target`),
  // and fees alone (above) would badly understate it -- see the module docstring's "costBps replacement".
  const exitTick = ticks.find((t) => t.observed_at.getTime() === exitObservedAt.getTime());
  const exitMid = exitTick ? midPriceForIv(exitTick.bid, exitTick.ask) : null;
  const entryMid = mid;
  const spreadCostRs = entryMid !== null && exitMid !== null
    ? ((entryTick.ask - entryMid) + (exitMid - exitPremium)) * quantity
    : null;
  const totalCostBpsOfUnderlying = spreadCostRs !== null && underlyingNotional > 0
    ? (((entryFees + exitFees) + spreadCostRs) / (2 * underlyingNotional)) * 10_000
    : undefined;

  return {
    status: "FILLED",
    strike, optionType, expiryDate,
    entryPremium: mapped.fillPremium, exitPremium, exitReason,
    quantity, entryFees, exitFees, grossPnl, netPnl,
    effectiveCostBpsOfPremium, effectiveCostBpsOfUnderlying, totalCostBpsOfUnderlying,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const approvalsResult = await database.query<{ comparison_key: string; v2_outcome: string }>(APPROVALS_QUERY);
    const rawApprovals: RawApproval[] = [];
    for (const row of approvalsResult.rows) {
      rawApprovals.push(...parseApprovals(row.comparison_key, row.v2_outcome));
    }
    console.info(`Parsed ${rawApprovals.length} side-approvals from ${approvalsResult.rows.length} decision rows.\n`);

    const instrumentSpecs = new Map<string, { strikeStep: number; lotSize: number }>();
    for (const instr of new Set(rawApprovals.map((a) => a.instrument))) {
      const specResult = await database.query<{ strike_step: string; lot_size: number }>(
        `SELECT strike_step::text, lot_size FROM instruments WHERE symbol = $1`, [instr],
      );
      const spec = specResult.rows[0];
      if (!spec) throw new Error(`No instruments row for ${instr}`);
      instrumentSpecs.set(instr, { strikeStep: Number(spec.strike_step), lotSize: Number(spec.lot_size) });
    }

    type Row = { approval: RawApproval; raw: RawGrade; costAdjusted: CostAdjustedGrade };
    const rows: Row[] = [];
    for (const approval of rawApprovals) {
      const raw = await gradeRaw(database, approval);
      const spec = instrumentSpecs.get(approval.instrument)!;
      const costAdjusted = await costAdjustedReprice(database, approval, spec.strikeStep, spec.lotSize);
      rows.push({ approval, raw, costAdjusted });
    }

    // ---- Raw index-point summary (sanity check against brain_v22_approval_grading.py) ----
    console.info("=== Raw index/futures points (sanity check vs brain_v22_approval_grading.py) ===");
    console.info(`Mean points/approval: ${mean(rows.map((r) => r.raw.points)).toFixed(2)}`);
    for (const instrument of instrumentSpecs.keys()) {
      const subset = rows.filter((r) => r.approval.instrument === instrument).map((r) => r.raw.points);
      console.info(`  ${instrument}: n=${subset.length}, mean=${mean(subset).toFixed(2)}, sum=${subset.reduce((a, b) => a + b, 0).toFixed(2)}`);
    }

    // ---- Coverage breakdown ----
    console.info("\n=== Real-repricing coverage ===");
    const statusCounts = new Map<string, number>();
    for (const row of rows) {
      statusCounts.set(row.costAdjusted.status, (statusCounts.get(row.costAdjusted.status) ?? 0) + 1);
    }
    console.table([...statusCounts.entries()].map(([status, n]) => ({ status, n })));

    const filled = rows.filter((r) => r.costAdjusted.status === "FILLED");
    console.info(`\n${filled.length} of ${rows.length} side-approvals (${(filled.length / rows.length * 100).toFixed(1)}%) genuinely repriced with real premium ticks.`);

    // ---- Cost-adjusted premium P&L ----
    console.info("\n=== Cost-adjusted premium P&L (real fills, real fees; FILLED only) ===");
    const netPnls = filled.map((r) => r.costAdjusted.netPnl!);
    console.info(`Mean net premium P&L per approval (Rs, one lot): ${mean(netPnls).toFixed(2)}`);
    console.info(`Sum net premium P&L (Rs, one lot each): ${netPnls.reduce((a, b) => a + b, 0).toFixed(2)}`);
    for (const instrument of instrumentSpecs.keys()) {
      const subset = filled.filter((r) => r.approval.instrument === instrument).map((r) => r.costAdjusted.netPnl!);
      console.info(`  ${instrument}: n=${subset.length}, mean=${mean(subset).toFixed(2)}, sum=${subset.reduce((a, b) => a + b, 0).toFixed(2)}`);
    }

    const premiumBpsValues = filled
      .map((r) => r.costAdjusted.effectiveCostBpsOfPremium)
      .filter((v): v is number => v !== undefined && Number.isFinite(v));
    const underlyingBpsValues = filled
      .map((r) => r.costAdjusted.effectiveCostBpsOfUnderlying)
      .filter((v): v is number => v !== undefined && Number.isFinite(v));
    const totalBpsValues = filled
      .map((r) => r.costAdjusted.totalCostBpsOfUnderlying)
      .filter((v): v is number => v !== undefined && Number.isFinite(v));
    console.info(`\nMean effective one-way fees, as bps of PREMIUM turnover: ${mean(premiumBpsValues).toFixed(2)} bps (n=${premiumBpsValues.length})`);
    console.info(`Mean effective one-way fees, as bps of UNDERLYING notional: ${mean(underlyingBpsValues).toFixed(4)} bps (n=${underlyingBpsValues.length})`);
    console.info("(Both are FEES ONLY -- neither includes the bid/ask spread. The underlying-notional figure is the same basis edge-assessor.ts's costBps uses.)");
    console.info(`\nMean effective one-way TOTAL cost (fees + round-trip bid/ask spread), as bps of UNDERLYING notional: ${mean(totalBpsValues).toFixed(4)} bps (n=${totalBpsValues.length} of ${filled.length} -- some FILLED rows could not solve an exit mid)`);
    console.info("(This is the figure used to replace decision-pipeline-input.ts's placeholderCostBps=2 -- see that file's updated comment for the derivation and its caveats.)");

    // ---- Per-approval detail dump (for the doc / audit trail) ----
    console.info("\n=== Per-approval detail ===");
    console.table(rows.map((r) => ({
      instrument: r.approval.instrument,
      decisionAt: r.approval.decisionAt.toISOString(),
      side: r.approval.side,
      rawOutcome: r.raw.outcome,
      rawPoints: Number(r.raw.points.toFixed(2)),
      status: r.costAdjusted.status,
      strike: r.costAdjusted.strike,
      optionType: r.costAdjusted.optionType,
      entryPremium: r.costAdjusted.entryPremium?.toFixed(2),
      exitPremium: r.costAdjusted.exitPremium?.toFixed(2),
      exitReason: r.costAdjusted.exitReason,
      netPnl: r.costAdjusted.netPnl?.toFixed(2),
    })));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
