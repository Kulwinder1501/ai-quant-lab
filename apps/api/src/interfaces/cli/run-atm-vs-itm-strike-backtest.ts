import "dotenv/config";
import {
  RISK_FREE_RATE,
  impliedVolatilityFromPremium,
  midPriceForIv,
  yearsToExpiry,
  type OptionType,
} from "@ai-quant-lab/pricing";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { calculateEntryFees, calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";
import { mapIdeaToOptionBuyerFill } from "../../modules/paper-trading/domain/option-buyer-fill.js";
import { decideOptionBuyerObservedExit, type ObservedPremiumSample } from "../../modules/paper-trading/domain/option-mark-to-market.js";
import { shouldFlattenAtSessionClose, istMinutesSinceMidnight, SESSION_CLOSE_FLATTEN_IST_MINUTES } from "../../modules/paper-trading/domain/session-close.js";
import type { PaperTrade } from "../../modules/paper-trading/domain/paper-trading.js";

/**
 * ATM vs ITM+1 (and, where data allows, ITM+2) option-buyer strike comparison.
 *
 * Answers a specific question raised against the live paper-trading system: it always buys
 * `nearestStrike(entry, step)` (ATM) in `prepare-option-entry.ts`, and ATM has such low delta
 * that roughly 1 index-vol point moves ~117 index points on the option (see project memory
 * `premium-target-unreachable-at-index-target`). A higher-delta ITM strike would track the
 * underlying's stop/target more linearly -- at the cost of whatever spread/liquidity is worse
 * on an ITM strike, which is exactly the thing a Black-Scholes re-pricing would hide and real
 * ticks do not.
 *
 * This is NOT a new backtest kernel. It replays real, already-decided historical entries
 * (the trade_ideas that produced every closed momentum-scalp / momentum-scalp-index option
 * position) through the *existing* reviewed domain functions --
 * `mapIdeaToOptionBuyerFill` (entry fill + stop/target repricing + the risk-reward-distortion
 * guard), `decideOptionBuyerObservedExit` (the oldest-first observed-tick barrier scan that is
 * also what `evaluate-open-paper-trades.ts` uses live), `calculateEntryFees` /
 * `calculateExitFees` (the real brokerage schedule), the live `MOMENTUM_STALL` policy table, and
 * `shouldFlattenAtSessionClose` (the 15:15 IST flatten) -- with one new parameter,
 * `strikeOverride` on `mapIdeaToOptionBuyerFill`, which is the one thing genuinely missing: the
 * live path always derives ATM and had no way to ask for a neighbouring strike. That parameter
 * is backtest-only; `prepare-option-entry.ts` never sets it, so live ATM selection is unchanged.
 *
 * Break-even/trail (`momentumScalp1mStopPolicy`) is currently OFF in production
 * (`breakEvenTriggerR: null`), so it is read here for faithfulness but is a no-op on this data --
 * the stop stays at its opening value for the whole trade, exactly as it did live.
 */

const STRIKE_VARIANTS = ["ATM", "ITM1", "ITM2"] as const;
type StrikeVariant = typeof STRIKE_VARIANTS[number];

const ENTRY_FRESHNESS_MS = 2 * 60 * 1000; // matches MAXIMUM_EXECUTABLE_QUOTE_AGE_MS in prepare-option-entry.ts
const FALLBACK_IV = 0.12;

/** Only timeframe this project has ever measured a stall policy for. */
const MOMENTUM_STALL_POLICIES: Readonly<Record<string, { cutoffMinutes: number; minimumProgressR: number } | undefined>> =
  Object.freeze({ "5m": { cutoffMinutes: 10, minimumProgressR: 0.5 } });
const MOMENTUM_STALL_ELIGIBLE_STRATEGIES = new Set(["momentum-scalp", "momentum-scalp-index"]);

interface SourceTradeRow {
  paper_trade_id: string;
  strategy_key: string;
  timeframe: string | null;
  symbol: string;
  strike_step: string;
  side: "LONG" | "SHORT";
  underlying_entry: string;
  underlying_stop: string;
  underlying_target: string;
  atm_strike: string;
  option_type: OptionType;
  option_expiry: Date;
  opened_at: Date;
  closed_at: Date;
  quantity: string;
  entry_iv: string | null;
  real_entry_price: string;
  real_exit_price: string | null;
  real_realized_pnl: string | null;
  real_exit_reason: string | null;
}

/** Raw shape as `pg` returns it: NUMERIC columns arrive as strings, never numbers. */
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

/**
 * `pg` returns NUMERIC columns as strings (no global type parser is registered in this
 * project -- see `postgres-option-premium-tick-repository.ts`'s own `toTick`, which does the
 * same conversion). Every downstream check here uses `Number.isFinite`, which is `false` for
 * a numeric string, so skipping this silently broke IV solving, the bid-basis offset and the
 * spread diagnostic -- all three read as "absent" instead of computed.
 */
function toTickRow(row: RawTickRow): TickRow {
  const toNum = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    observed_at: row.observed_at,
    bid: toNum(row.bid),
    ask: toNum(row.ask),
    underlying_value: toNum(row.underlying_value),
  };
}

interface VariantOutcome {
  variant: StrikeVariant;
  strike: number;
  status: "FILLED" | "NO_ENTRY_QUOTE" | "GEOMETRY_REFUSED" | "NO_EXIT_RESOLVED";
  entryPremium?: number;
  exitPremium?: number;
  exitReason?: string;
  exitAt?: Date;
  quantity?: number;
  entryFees?: number;
  exitFees?: number;
  grossPnl?: number;
  netPnl?: number;
  entrySpreadPct?: number; // (ask - bid) / mid at entry, liquidity proxy
  exitSpreadAvailable?: boolean;
  detail?: string;
}

function offsetStrike(side: "LONG" | "SHORT", atm: number, step: number, itmSteps: number): number {
  // A CE (LONG idea) is ITM below spot -> lower strike. A PE (SHORT idea) is ITM above spot.
  return side === "LONG" ? atm - itmSteps * step : atm + itmSteps * step;
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
      AND observed_at <= $5 AND observed_at >= $5::timestamptz - interval '2 minutes'
      AND ask IS NOT NULL AND ask > 0
    ORDER BY observed_at DESC
    LIMIT 1
    `,
    [args.symbol, args.expiryDate.toISOString().slice(0, 10), args.strike, args.optionType, args.asOf],
  );
  const row = result.rows[0];
  return row ? toTickRow(row) : null;
}

async function fetchTicksBetween(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: RawTickRow[] }> },
  args: { symbol: string; expiryDate: Date; strike: number; optionType: OptionType; after: Date; to: Date },
): Promise<TickRow[]> {
  const result = await database.query(
    `
    SELECT observed_at, bid, ask, underlying_value
    FROM option_premium_ticks
    WHERE underlying_symbol = $1 AND expiry_date = $2::date AND strike_price = $3 AND option_type = $4
      AND observed_at > $5 AND observed_at <= $6
    ORDER BY observed_at ASC
    `,
    [args.symbol, args.expiryDate.toISOString().slice(0, 10), args.strike, args.optionType, args.after, args.to],
  );
  return result.rows.map(toTickRow);
}

/** 15:15 IST square-off instant on the same calendar day (IST) as `openedAt`. */
function sessionCloseInstantFor(openedAt: Date): Date {
  const minutesNow = istMinutesSinceMidnight(openedAt);
  const msToClose = (SESSION_CLOSE_FLATTEN_IST_MINUTES - minutesNow) * 60_000;
  return new Date(openedAt.getTime() + msToClose);
}

async function replayVariant(
  database: { query: (text: string, values?: unknown[]) => Promise<{ rows: RawTickRow[] }> },
  trade: SourceTradeRow,
  variant: StrikeVariant,
): Promise<VariantOutcome> {
  const step = Number(trade.strike_step);
  const atm = Number(trade.atm_strike);
  const itmSteps = variant === "ATM" ? 0 : variant === "ITM1" ? 1 : 2;
  const strike = offsetStrike(trade.side, atm, step, itmSteps);
  const quantity = Number(trade.quantity);
  const expiry = new Date(trade.option_expiry);
  const openedAt = new Date(trade.opened_at);

  const entryTick = await fetchEntryTick(database, {
    symbol: trade.symbol,
    expiryDate: expiry,
    strike,
    optionType: trade.option_type,
    asOf: openedAt,
  });
  if (!entryTick || entryTick.ask === null || entryTick.ask <= 0) {
    return { variant, strike, status: "NO_ENTRY_QUOTE", detail: "no fillable ask within the 2-minute entry freshness window" };
  }
  if (openedAt.getTime() - entryTick.observed_at.getTime() > ENTRY_FRESHNESS_MS) {
    return { variant, strike, status: "NO_ENTRY_QUOTE", detail: "nearest ask older than the live freshness window" };
  }

  const mid = midPriceForIv(entryTick.bid, entryTick.ask);
  const spot = entryTick.underlying_value ?? Number(trade.underlying_entry);
  const T = yearsToExpiry(entryTick.observed_at, expiry);
  const ivResult = mid !== null && spot > 0
    ? impliedVolatilityFromPremium({
      spot,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: RISK_FREE_RATE,
      optionType: trade.option_type,
      premium: mid,
    })
    : { measurable: false as const };
  const solvedIv = ivResult.measurable ? ivResult.impliedVolatility : (trade.entry_iv !== null ? Number(trade.entry_iv) : FALLBACK_IV);

  let mapped: ReturnType<typeof mapIdeaToOptionBuyerFill>;
  try {
    mapped = mapIdeaToOptionBuyerFill({
      ideaSide: trade.side,
      underlyingEntry: Number(trade.underlying_entry),
      underlyingStop: Number(trade.underlying_stop),
      underlyingTarget: Number(trade.underlying_target),
      impliedVolatility: solvedIv,
      expiryDate: expiry,
      strikeStep: step,
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
      variant, strike, status: "GEOMETRY_REFUSED",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const entryFees = calculateEntryFees(mapped.fillPremium, quantity).total;
  const entrySpreadPct = entryTick.bid !== null && entryTick.bid > 0 && mid !== null
    ? (entryTick.ask - entryTick.bid) / mid
    : undefined;

  // Mock trade object carrying only the fields the domain functions actually read.
  const mockTrade = {
    status: "OPEN",
    side: "LONG",
    stopLoss: mapped.stopPremium,
    targetPrice: mapped.targetPremium,
  } as unknown as PaperTrade;

  // Cap the walk window generously; every trade in this cohort is intraday (1m/5m), so the
  // session-close flatten or a barrier crossing resolves it long before expiry in practice.
  const walkEnd = new Date(Math.min(expiry.getTime(), openedAt.getTime() + 24 * 60 * 60 * 1000));
  const ticks = await fetchTicksBetween(database, {
    symbol: trade.symbol,
    expiryDate: expiry,
    strike,
    optionType: trade.option_type,
    after: openedAt,
    to: walkEnd,
  });
  const samples: ObservedPremiumSample[] = ticks.map((t) => ({
    observedAt: t.observed_at,
    bid: t.bid,
    underlyingValue: t.underlying_value,
  }));

  const barrier = decideOptionBuyerObservedExit(mockTrade, samples);

  // Session-close candidate: the flatten fires on the first fresh bid at/after 15:15 IST.
  const flattenApplies = shouldFlattenAtSessionClose(trade.timeframe, sessionCloseInstantFor(openedAt));
  let sessionCloseCandidate: { at: Date; bid: number } | null = null;
  if (flattenApplies) {
    const closeInstant = sessionCloseInstantFor(openedAt);
    const freshAtClose = [...samples]
      .filter((s) => s.observedAt.getTime() >= closeInstant.getTime()
        && s.observedAt.getTime() <= closeInstant.getTime() + ENTRY_FRESHNESS_MS
        && s.bid !== null && s.bid > 0)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())[0];
    if (freshAtClose) sessionCloseCandidate = { at: freshAtClose.observedAt, bid: freshAtClose.bid! };
  }

  // Momentum-stall candidate, only for the strategy/timeframe cells the live policy covers.
  let stallCandidate: { at: Date; bid: number } | null = null;
  const stallPolicy = trade.timeframe && MOMENTUM_STALL_ELIGIBLE_STRATEGIES.has(trade.strategy_key)
    ? MOMENTUM_STALL_POLICIES[trade.timeframe]
    : undefined;
  if (stallPolicy) {
    const initialRisk = mapped.fillPremium - mapped.stopPremium;
    const isScalp = initialRisk > 0
      ? (mapped.targetPremium - mapped.fillPremium) / initialRisk <= 1.6
      : false;
    if (isScalp && initialRisk > 0) {
      const cutoffAt = openedAt.getTime() + stallPolicy.cutoffMinutes * 60_000;
      let peakBid = mapped.fillPremium;
      for (const sample of [...samples].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())) {
        if (sample.bid !== null && sample.bid > peakBid) peakBid = sample.bid;
        if (sample.observedAt.getTime() < cutoffAt) continue;
        const progressMade = peakBid >= mapped.fillPremium + stallPolicy.minimumProgressR * initialRisk;
        if (!progressMade && sample.bid !== null && sample.bid > 0) {
          stallCandidate = { at: sample.observedAt, bid: sample.bid };
          break;
        }
        if (progressMade) break; // never re-triggers once genuine progress was made
      }
    }
  }

  const candidates = [
    barrier ? { at: barrier.observedAt, bid: barrier.exitPrice, reason: barrier.reason as string } : null,
    sessionCloseCandidate ? { at: sessionCloseCandidate.at, bid: sessionCloseCandidate.bid, reason: "SESSION_CLOSE" } : null,
    stallCandidate ? { at: stallCandidate.at, bid: stallCandidate.bid, reason: "MOMENTUM_STALL" } : null,
  ].filter((c): c is { at: Date; bid: number; reason: string } => c !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const chosen = candidates[0];
  if (!chosen) {
    return {
      variant, strike, status: "NO_EXIT_RESOLVED",
      entryPremium: mapped.fillPremium, quantity, entryFees, entrySpreadPct,
      detail: `no barrier/stall/session-close resolution found in ${samples.length} ticks through ${walkEnd.toISOString()}`,
    };
  }

  const exitFees = calculateExitFees(chosen.bid, quantity).total;
  const grossPnl = (chosen.bid - mapped.fillPremium) * quantity;
  const netPnl = grossPnl - entryFees - exitFees;

  return {
    variant, strike, status: "FILLED",
    entryPremium: mapped.fillPremium,
    exitPremium: chosen.bid,
    exitReason: chosen.reason,
    exitAt: chosen.at,
    quantity, entryFees, exitFees, grossPnl, netPnl, entrySpreadPct,
    exitSpreadAvailable: samples.some((s) => s.bid !== null),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Paired t-statistic for variant net P&L vs ATM net P&L, over trades both variants filled. */
function pairedT(atmPnl: number[], variantPnl: number[]): { t: number; n: number; meanDiff: number } {
  const n = Math.min(atmPnl.length, variantPnl.length);
  const diffs: number[] = [];
  for (let i = 0; i < n; i += 1) diffs.push(variantPnl[i]! - atmPnl[i]!);
  const m = mean(diffs);
  const sd = stddev(diffs);
  const t = sd === 0 || diffs.length < 2 ? 0 : m / (sd / Math.sqrt(diffs.length));
  return { t, n: diffs.length, meanDiff: m };
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const sourceResult = await database.query<SourceTradeRow>(`
      SELECT
        pt.id AS paper_trade_id,
        s.strategy_key,
        sc.timeframe,
        i.symbol,
        i.strike_step::text,
        ti.side,
        ti.entry_price::text AS underlying_entry,
        ti.stop_loss::text AS underlying_stop,
        ti.target_price::text AS underlying_target,
        pt.option_strike::text AS atm_strike,
        pt.option_type,
        pt.option_expiry,
        pt.opened_at,
        pt.closed_at,
        pt.quantity::text AS quantity,
        pt.entry_iv::text AS entry_iv,
        pt.entry_price::text AS real_entry_price,
        pt.exit_price::text AS real_exit_price,
        pt.realized_pnl::text AS real_realized_pnl,
        pt.exit_reason AS real_exit_reason
      FROM paper_trades pt
      JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
      JOIN strategy_versions sv ON sv.id = ti.strategy_version_id
      JOIN strategies s ON s.id = sv.strategy_id
      JOIN instruments i ON i.id = pt.instrument_id
      LEFT JOIN candles sc ON sc.id = ti.source_candle_id
      WHERE pt.option_strike IS NOT NULL
        AND pt.status = 'CLOSED'
        AND s.strategy_key IN ('momentum-scalp', 'momentum-scalp-index')
      ORDER BY s.strategy_key, i.symbol, pt.opened_at
    `);

    type Row = { trade: SourceTradeRow; outcomes: Record<StrikeVariant, VariantOutcome> };
    const rows: Row[] = [];
    for (const trade of sourceResult.rows) {
      const outcomes = {} as Record<StrikeVariant, VariantOutcome>;
      for (const variant of STRIKE_VARIANTS) {
        outcomes[variant] = await replayVariant(database, trade, variant);
      }
      rows.push({ trade, outcomes });
    }

    // ---- Aggregate per (strategy_key, symbol, variant) ----
    type CellKey = string;
    const cells = new Map<CellKey, {
      strategyKey: string; symbol: string; variant: StrikeVariant;
      nEligible: number; nFilled: number; nWins: number;
      grossPnls: number[]; netPnls: number[]; entrySpreads: number[];
    }>();

    for (const { trade, outcomes } of rows) {
      for (const variant of STRIKE_VARIANTS) {
        const key = `${trade.strategy_key}|${trade.symbol}|${variant}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { strategyKey: trade.strategy_key, symbol: trade.symbol, variant, nEligible: 0, nFilled: 0, nWins: 0, grossPnls: [], netPnls: [], entrySpreads: [] };
          cells.set(key, cell);
        }
        cell.nEligible += 1;
        const outcome = outcomes[variant];
        if (outcome.status === "FILLED" && outcome.netPnl !== undefined) {
          cell.nFilled += 1;
          if (outcome.netPnl > 0) cell.nWins += 1;
          cell.grossPnls.push(outcome.grossPnl!);
          cell.netPnls.push(outcome.netPnl);
          if (outcome.entrySpreadPct !== undefined) cell.entrySpreads.push(outcome.entrySpreadPct);
        }
      }
    }

    console.info("\n=== ATM vs ITM strike-offset backtest: momentum-scalp / momentum-scalp-index ===\n");
    console.info(`Source trades: ${rows.length} closed option-buyer positions (real, already-executed historical entries)\n`);

    const summaryRows: Record<string, unknown>[] = [];
    for (const key of [...cells.keys()].sort()) {
      const c = cells.get(key)!;
      const winRate = c.nFilled > 0 ? c.nWins / c.nFilled : null;
      const netTotal = c.netPnls.reduce((a, b) => a + b, 0);
      const grossWin = c.grossPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(c.grossPnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
      const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
      const avgSpread = c.entrySpreads.length > 0 ? mean(c.entrySpreads) : null;
      summaryRows.push({
        strategyKey: c.strategyKey, symbol: c.symbol, variant: c.variant,
        nEligible: c.nEligible, nFilled: c.nFilled,
        fillRate: c.nEligible > 0 ? Number((c.nFilled / c.nEligible * 100).toFixed(1)) : null,
        winRate: winRate !== null ? Number((winRate * 100).toFixed(1)) : null,
        netPnlTotal: Number(netTotal.toFixed(2)),
        netPnlPerTrade: c.nFilled > 0 ? Number((netTotal / c.nFilled).toFixed(2)) : null,
        profitFactor: profitFactor !== null && Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(3)) : profitFactor,
        avgEntrySpreadPct: avgSpread !== null ? Number((avgSpread * 100).toFixed(3)) : null,
      });
    }
    console.table(summaryRows);

    // ---- Paired significance: ATM vs ITM1 net P&L, over trades where BOTH variants filled ----
    console.info("\n=== Paired ATM vs ITM1 net P&L (trades where both variants produced a real fill+exit) ===\n");
    const byGroup = new Map<string, { atm: number[]; itm1: number[] }>();
    for (const { trade, outcomes } of rows) {
      const atmOut = outcomes.ATM;
      const itm1Out = outcomes.ITM1;
      if (atmOut.status === "FILLED" && itm1Out.status === "FILLED"
        && atmOut.netPnl !== undefined && itm1Out.netPnl !== undefined) {
        const groupKey = `${trade.strategy_key}|${trade.symbol}`;
        let group = byGroup.get(groupKey);
        if (!group) { group = { atm: [], itm1: [] }; byGroup.set(groupKey, group); }
        group.atm.push(atmOut.netPnl);
        group.itm1.push(itm1Out.netPnl);
      }
    }
    const pairedRows: Record<string, unknown>[] = [];
    for (const key of [...byGroup.keys()].sort()) {
      const { atm, itm1 } = byGroup.get(key)!;
      const { t, n, meanDiff } = pairedT(atm, itm1);
      pairedRows.push({
        group: key, n,
        meanNetPnlDiff_ITM1_minus_ATM: Number(meanDiff.toFixed(2)),
        pairedT: Number(t.toFixed(3)),
        // ~1.96 for 5% two-sided at large n; flagged rather than computed exactly since n varies per cell.
        likelySignificantAt5pct: Math.abs(t) > 1.96,
      });
    }
    console.table(pairedRows);

    // ---- Data-availability breakdown (why a variant did or didn't fill) ----
    console.info("\n=== Fill/refusal breakdown by variant (data-availability honesty check) ===\n");
    const statusCounts = new Map<string, number>();
    for (const { outcomes } of rows) {
      for (const variant of STRIKE_VARIANTS) {
        const k = `${variant}|${outcomes[variant].status}`;
        statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
      }
    }
    console.table([...statusCounts.entries()].sort().map(([k, n]) => {
      const [variant, status] = k.split("|");
      return { variant, status, n };
    }));

    // ---- Cross-check: replayed ATM net P&L vs the REAL recorded paper_trades P&L ----
    console.info("\n=== Sanity check: replayed ATM vs real recorded paper_trades P&L (should track closely) ===\n");
    let replayedAtmTotal = 0;
    let realTotal = 0;
    let atmComparable = 0;
    for (const { trade, outcomes } of rows) {
      if (outcomes.ATM.status === "FILLED" && outcomes.ATM.netPnl !== undefined && trade.real_realized_pnl !== null) {
        replayedAtmTotal += outcomes.ATM.netPnl;
        realTotal += Number(trade.real_realized_pnl);
        atmComparable += 1;
      }
    }
    console.info(JSON.stringify({
      atmComparableTrades: atmComparable,
      replayedAtmNetPnlTotal: Number(replayedAtmTotal.toFixed(2)),
      realRecordedNetPnlTotal: Number(realTotal.toFixed(2)),
      note: "Differences are expected: the real bot's evaluator ran on a ~5-minute sweep cadence and this "
        + "replay scans every collected tick, so it can resolve a barrier crossing the live sweep missed "
        + "between two runs, or vice versa if session-close/stall timing differs slightly.",
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
