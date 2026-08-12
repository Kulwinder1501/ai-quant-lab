import type { DatabasePool } from "../../../infrastructure/database/database.js";
import type { StrategyMarketContextRepository, TradeIdeaRepository, TradeSide } from "../domain/strategy.js";
import type { PaperAccountRepository, PaperTradeRepository, PaperTrade } from "../../paper-trading/domain/paper-trading.js";
import { EvaluateOpenPaperTrades } from "../../paper-trading/application/evaluate-open-paper-trades.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import type { CandleRepository } from "../../market-data/domain/candle.js";
import type { NewsRepository } from "../../news-sentiment/domain/news-article.js";
import type { PostgresAiJournalRepository } from "../../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { PostgresTradeReviewRepository } from "../../../infrastructure/database/repositories/postgres-trade-review-repository.js";
import { scoreDirectionalSetup } from "../domain/directional-setup-score.js";
import { assessContractSize } from "../../paper-trading/domain/contract-specs.js";
import { calculateExitFees } from "../../paper-trading/domain/brokerage-calculator.js";
import { isOptionBuyerTrade } from "../../paper-trading/domain/option-mark-to-market.js";
import { OpenOptionPositionFromIdea } from "../../paper-trading/application/open-option-position-from-idea.js";
import { OpenPaperTrade } from "../../paper-trading/application/open-paper-trade.js";
import { PrepareOptionEntry } from "../../paper-trading/application/prepare-option-entry.js";
import { PostgresOptionChainRepository } from "../../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { PostgresRiskStateRepository } from "../../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { buildTradeReview } from "../../paper-trading/domain/trade-review.js";
import { INSTITUTIONAL_FLOW_STALENESS_DAYS } from "../../market-data/domain/institutional-flow-summary.js";
import { loadIndexDriverTape } from "../../market-data/application/load-index-driver-tape.js";
import { driverTapeBias as scoreDriverTapeBias, type DriverTapeMetrics } from "../../market-data/domain/driver-tape.js";
import type { CheckMacroEventsService } from "../../news-sentiment/application/check-macro-events.js";
import { PostgresDriverTapeAdjustmentRepository } from "../../../infrastructure/database/repositories/postgres-driver-tape-adjustment-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import {
  assessDataFreshness,
  barLengthMinutes,
  DEFAULT_MAX_BAR_AGE_MINUTES,
} from "../../paper-trading/domain/bot-data-freshness.js";
import { measureSmcConfluence } from "../domain/smc-confluence.js";
import { SMC_ALGORITHM_VERSION } from "../../technical-analysis/domain/technical-indicator.js";

export interface AiBrainThought {
  id: string;
  timestamp: string;
  symbol: string;
  action: "ANALYZING" | "PROPOSING" | "EXECUTING" | "LEARNING" | "MONITORING";
  confidence: number;
  message: string;
  details: Record<string, unknown>;
}

export interface AiReflectionLog {
  id: string;
  timestamp: string;
  tradeId: string;
  symbol: string;
  side: TradeSide;
  pnl: number;
  outcome: "WIN" | "LOSS";
  analysis: string;
  improvementRule: string;
}

export interface AgentPerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  reflections: AiReflectionLog[];
  recentThoughts: AiBrainThought[];
}

/**
 * How stale a published FII/DII print may be before the agent ignores it.
 *
 * Aliases the market-data domain constant rather than redefining 5, so the agent,
 * the dashboard summary, and the ML loader cannot drift to different windows.
 */
export const INSTITUTIONAL_FLOW_MAX_AGE_DAYS = INSTITUTIONAL_FLOW_STALENESS_DAYS;

/**
 * The indicator algorithm version the agent trusts, matching what the strategies
 * pin in `indicatorAlgorithmVersion`. Snapshots exist under other versions (the
 * seed writes its own simpler variants), and those must not be substituted for
 * production values just because they share an indicator code.
 */
export const PRODUCTION_INDICATOR_VERSION = "ta-v1";

/**
 * Stop and target sizing for agent-executed trades, matching the trend-breakout
 * strategy's convention (`atrStopMultiple: 1.5`, `rewardRiskMultiple: 2`).
 *
 * The agent previously bracketed every trade at a flat 1.5% stop / 3% target of
 * the live price. A fixed percentage ignores both the timeframe being ticked and
 * the prevailing volatility: on a 15m context it produced a ~370-point NIFTY
 * stop where the measured 15m ATR is ~30 points. Scaling by ATR makes the same
 * multiples mean the same thing on every timeframe and in every regime.
 */
export const AGENT_ATR_STOP_MULTIPLE = 1.5;
export const AGENT_REWARD_RISK_MULTIPLE = 2;

/**
 * Sides the agent will actually execute, as opposed to score.
 *
 * SHORT is scored, reported and journalled -- it is simply not traded, because it has been
 * measured and it loses. `npm run measure:directional-scorer` replays the scorer over stored
 * history with the agent's own bracket and the paper-trading exit rules. On 15m, patterns current
 * as of 2026-08-10, against a 0.3333 break-even hit rate:
 *
 * | instrument | side  | gated hit (n)   | gated expectancy | unconditional hit | delta   |
 * |------------|-------|-----------------|------------------|-------------------|---------|
 * | NIFTY50    | LONG  | 0.3351 (367)    | +0.005R          | 0.3370            | -0.0019 |
 * | NIFTY50    | SHORT | 0.2950 (261)    | **-0.262R**      | 0.3595            | -0.0645 |
 * | BANKNIFTY  | LONG  | 0.3850 (413)    | +0.182R          | 0.3568            | +0.0282 |
 * | BANKNIFTY  | SHORT | 0.2478 (347)    | **-0.376R**      | 0.3315            | -0.0837 |
 *
 * The short gate is below break-even on both instruments, strongly negative in expectancy, and
 * 6-8 points *worse than taking every bar short* -- so it is not merely unhelpful, it reliably
 * selects bad shorts. The long gate is roughly neutral: positive on both but inconsistent in
 * sign relative to its baseline, so it is left enabled without any claim of edge.
 *
 * This is a measured gate, not the earlier structural argument. It should be revisited by
 * re-running the measurement, not by reasoning about the terms -- and if the short side's numbers
 * come back above its baseline on more than one instrument, add "SHORT" back here.
 */
export const AGENT_EXECUTABLE_SIDES: readonly TradeSide[] = ["LONG"];

/**
 * Entry costs are **not** defined here.
 *
 * There were briefly `AGENT_FEE_PER_ORDER_INR` and an `agentSlippageInr` helper in this file,
 * modelled on the backtest engine's cash-order shape. They existed only because the agent was
 * booking a position at the index's own level, which `brokerage-calculator.ts` cannot price --
 * it charges option premium turnover at option STT rates. Now that entries go through
 * `PrepareOptionEntry`, the position is a real option contract and the brokerage model applies
 * directly, so the estimate is gone rather than kept alongside the measured figure.
 *
 * The sentiment circuit breaker's exit uses `calculateExitFees` on the observed premium for the
 * same reason -- see `resolvePanicExitPremium`.
 */

/**
 * How many thoughts the in-memory ring keeps.
 *
 * The array was unbounded and only ever read through a tail slice, so a long-lived API or
 * scheduler process grew it forever -- roughly 86k entries a day once the tick ran on a
 * per-second cadence. The dashboard asks for at most a few dozen.
 */
export const MAX_RETAINED_THOUGHTS = 200;

export interface InstitutionalFlowBias {
  /** Confidence points to add to a long-biased score. Negative discounts the trade. */
  adjustment: number;
  reasoning: string | null;
}

/**
 * Grade the institutional-flow bias for a long-biased confidence score.
 *
 * Three things this fixes over the original flat ±10 at |FII| > 1000 Cr:
 *
 * 1. DII is included. It was queried and parsed but never read, which mattered
 *    because DII routinely absorbs FII selling — a -3000 Cr FII day against
 *    +2800 Cr DII is a rotation, not an exodus, and penalising it as though it
 *    were the latter is simply the wrong reading of the tape.
 * 2. It is graded rather than binary, so 1001 Cr and 12000 Cr no longer score
 *    identically.
 * 3. Outflows are weighted more heavily than inflows (the 1.5x below). This is
 *    what "heavily discounting bullish trades on extreme FII outflows" in the
 *    phase-22 doc actually asks for, and it matches the asymmetry the rest of
 *    this scorer already applies to bad news.
 *
 * Bands are in crore of *combined* net cash flow. They are deliberately coarse:
 * these are hand-set heuristics for a long-biased score, not a fitted model, and
 * the ML path gets its own scale-free feature instead.
 */
export function institutionalFlowBias(
  fiiCashNetCr: number | null,
  diiCashNetCr: number | null,
): InstitutionalFlowBias {
  // Absent data must not read as a flat market, so a null is not treated as 0.
  if (fiiCashNetCr === null && diiCashNetCr === null) {
    return { adjustment: 0, reasoning: null };
  }

  const fii = fiiCashNetCr ?? 0;
  const dii = diiCashNetCr ?? 0;
  const combined = fii + dii;
  const magnitude = Math.abs(combined);

  let points: number;
  if (magnitude < 500) points = 0;
  else if (magnitude < 2_000) points = 5;
  else if (magnitude < 5_000) points = 10;
  else points = 18;

  if (points === 0) {
    return {
      adjustment: 0,
      reasoning: `Institutional flows broadly balanced (FII ₹${fii.toFixed(0)}Cr, DII ₹${dii.toFixed(0)}Cr).`,
    };
  }

  const bullish = combined > 0;
  const adjustment = bullish ? points : -Math.round(points * 1.5);
  const descriptor = magnitude >= 5_000 ? "Extreme" : magnitude >= 2_000 ? "Strong" : "Mild";
  const rotation =
    Math.sign(fii) !== Math.sign(dii) && Math.min(Math.abs(fii), Math.abs(dii)) > 500
      ? " Counter-flow between FII and DII suggests rotation rather than a one-sided exit."
      : "";

  return {
    adjustment,
    reasoning:
      `${descriptor} net institutional ${bullish ? "inflows" : "outflows"}: ` +
      `FII ₹${fii.toFixed(0)}Cr, DII ₹${dii.toFixed(0)}Cr (combined ₹${combined.toFixed(0)}Cr).${rotation}`,
  };
}

/** The one chain method the breaker-exit path needs, so a test does not implement a repository. */
export interface ContractQuoteReader {
  latestContractQuote(input: {
    underlyingSymbol: string;
    expiryDate: Date;
    strikePrice: number;
    optionType: "CE" | "PE";
  }): Promise<{ mid: number; bid: number | null; ask: number | null } | null>;
}

export class AiAutonomousAgent {
  private readonly thoughts: AiBrainThought[] = [];
  private readonly evaluateTrades: EvaluateOpenPaperTrades;
  /** Every entry goes through here, so the option gates and the risk engine cannot be skipped. */
  private readonly openOptionPosition: OpenOptionPositionFromIdea;
  /** Read-only, for pricing a breaker exit against the observed book. */
  private readonly optionChainRepository: ContractQuoteReader;
  private lastTradeAttempt: Map<string, number> = new Map();

  constructor(
    private readonly database: DatabasePool,
    private readonly marketContextRepo: StrategyMarketContextRepository,
    private readonly tradeIdeaRepo: TradeIdeaRepository,
    private readonly accountRepo: PaperAccountRepository,
    private readonly paperTradeRepo: PaperTradeRepository,
    candleRepo: CandleRepository,
    private readonly newsRepo: NewsRepository,
    private readonly aiJournalRepo: PostgresAiJournalRepository,
    private readonly checkMacroEvents?: CheckMacroEventsService,
    /**
     * Seams for tests, both defaulted to the real thing.
     *
     * Grouped into one optional object rather than trailing positional parameters: this
     * constructor already takes eight, and the two collaborators below are the ones that place and
     * price real positions. Passing nothing gets the gated implementations, so a caller cannot
     * weaken the entry path by getting an argument position wrong.
     */
    overrides?: {
      openOptionPosition?: OpenOptionPositionFromIdea;
      optionChainRepository?: ContractQuoteReader;
    },
  ) {
    this.evaluateTrades = new EvaluateOpenPaperTrades(
      paperTradeRepo,
      candleRepo,
      new PostgresIndiaVixImpliedVolatilitySource(database),
      new PostgresOptionPremiumTickRepository(database),
    );
    this.optionChainRepository = overrides?.optionChainRepository
      ?? new PostgresOptionChainRepository(database);
    this.openOptionPosition = overrides?.openOptionPosition ?? new OpenOptionPositionFromIdea(
      new PrepareOptionEntry(database, new PostgresOptionChainRepository(database)),
      new OpenPaperTrade(paperTradeRepo),
      new PostgresRiskStateRepository(database),
    );
  }

  public getThoughts(limit = 15): AiBrainThought[] {
    return this.thoughts.slice(-limit).reverse();
  }

  /**
   * The premium a panic liquidation would actually receive, or null if it cannot be observed.
   *
   * The bid is preferred over the mid: this position is being **sold**, in a hurry, and the bid
   * is what a seller crossing the spread gets. Marking a forced exit at the mid reports a better
   * fill than a panic would ever achieve, which flatters exactly the trades the breaker exists to
   * cut. Falls back to the mid when the book publishes no bid, and records which was used.
   *
   * Returns null rather than substituting a model price. A Black-Scholes mark and the book's bid
   * differed by 179 points on a live BANKNIFTY 57700 CE in this project's own measurements, so a
   * model exit is a wrong realized P&L, not an approximation of a right one.
   */
  private async resolvePanicExitPremium(
    trade: PaperTrade,
  ): Promise<{ premium: number; source: "OBSERVED_BID" | "OBSERVED_MID" } | null> {
    if (!isOptionBuyerTrade(trade)) {
      // A non-option position cannot arise from this agent any more, and closing one at the
      // underlying's level is precisely the bug being removed, so it is refused rather than
      // guessed at. The ordinary stop/target evaluation still manages such a position.
      return null;
    }
    try {
      const quote = await this.optionChainRepository.latestContractQuote({
        underlyingSymbol: String(trade.underlyingSymbol).toUpperCase(),
        expiryDate: trade.optionExpiry as Date,
        strikePrice: Number(trade.optionStrike),
        optionType: trade.optionType as "CE" | "PE",
      });
      if (quote === null) return null;
      if (quote.bid !== null && Number.isFinite(quote.bid) && quote.bid > 0) {
        return { premium: quote.bid, source: "OBSERVED_BID" };
      }
      if (Number.isFinite(quote.mid) && quote.mid > 0) {
        return { premium: quote.mid, source: "OBSERVED_MID" };
      }
      return null;
    } catch {
      // A chain lookup failure must not become a fabricated exit.
      return null;
    }
  }

  /**
   * The thought stream as the dashboard should see it: from the database, not this process.
   *
   * `getThoughts` above reads the in-memory ring, which is only populated in the process that ran
   * the tick. Since the tick moved to the scheduler's `AI_AGENT_TICK` job, that is never the API
   * process serving the dashboard -- so the brain panel rendered zero thoughts beside six
   * reflections while the agent was running normally elsewhere. Reflections were already persisted;
   * thoughts were not. This is the read side of migration 052.
   */
  public async listRecentThoughts(limit = 15, symbol?: string): Promise<AiBrainThought[]> {
    try {
      return await this.aiJournalRepo.getRecentThoughts(limit, symbol);
    } catch {
      // A journal read failure must not blank a panel that has an in-process answer available.
      return this.getThoughts(limit);
    }
  }

  /**
   * Appends a thought to the in-memory ring and persists it.
   *
   * Every site that used to call `this.thoughts.push` directly goes through here. The ring is
   * bounded because it is only ever read as a tail slice, and retaining more than the window is
   * pure growth in a process that never exits.
   *
   * The write is deliberately **not** awaited by callers: `tick` is on a scheduler cadence and a
   * journal outage must not stop it evaluating stops or opening positions. A failure is logged and
   * dropped, because a thought is a record of a decision rather than part of making one.
   */
  private recordThought(thought: AiBrainThought): void {
    this.thoughts.push(thought);
    if (this.thoughts.length > MAX_RETAINED_THOUGHTS) {
      this.thoughts.splice(0, this.thoughts.length - MAX_RETAINED_THOUGHTS);
    }
    void this.aiJournalRepo.saveThought(thought).catch((error: unknown) => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "Failed to persist an agent thought; it stays in memory only.",
        thoughtId: thought.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  public async getReflections(limit = 20): Promise<AiReflectionLog[]> {
    return this.aiJournalRepo.getRecentReflections(limit);
  }

  public async getPerformanceMetrics(accountId: string, period: string = "1d"): Promise<AgentPerformanceMetrics> {
    const closedTrades = await this.listClosedTrades(accountId, period);
    let totalWins = 0;
    let totalLosses = 0;
    let totalWinPnl = 0;
    let totalLossPnl = 0;
    
    // Read reflections from DB
    const reflections = await this.aiJournalRepo.getRecentReflections(20);

    for (const trade of [...closedTrades].reverse()) {
      if (!reflections.some((r) => r.tradeId === trade.id)) {
        await this.generateSelfReflection(trade.id, trade.instrumentSymbol || "NIFTY50");
      }
    }

    for (const trade of closedTrades) {
      const pnl = trade.realizedPnl ?? 0;
      if (pnl >= 0) {
        totalWins += 1;
        totalWinPnl += pnl;
      } else {
        totalLosses += 1;
        totalLossPnl += Math.abs(pnl);
      }
    }

    const totalTrades = closedTrades.length;
    const winRate = totalTrades > 0 ? Number(((totalWins / totalTrades) * 100).toFixed(1)) : 0;
    const netPnl = Number((totalWinPnl - totalLossPnl).toFixed(2));
    const profitFactor = totalLossPnl > 0 ? Number((totalWinPnl / totalLossPnl).toFixed(2)) : totalWinPnl > 0 ? 99.99 : 0;

    return {
      totalTrades,
      winningTrades: totalWins,
      losingTrades: totalLosses,
      winRate,
      netPnl,
      profitFactor,
      reflections: await this.aiJournalRepo.getRecentReflections(10),
      recentThoughts: await this.listRecentThoughts(10),
    };
  }

  public async tick(symbol: string, timeframe: string, livePrice: number): Promise<void> {
    const now = new Date();
    const ts = now.toISOString();

    // 1. Resolve active paper account
    let account = await this.accountRepo.findByName("Default Paper Account");
    if (!account) {
      const client = await this.database.connect();
      try {
        const res = await client.query<{ id: string }>("SELECT id FROM paper_accounts LIMIT 1");
        if (res.rows[0]?.id) {
          account = await this.accountRepo.findById(res.rows[0].id);
        }
      } finally {
        client.release();
      }
    }
    if (!account) return;

    // 2. Evaluate any open trades against current live market price
    try {
      const evalRes = await this.evaluateTrades.execute({
        accountId: account.id,
        asOf: now,
        livePrices: { [symbol.toUpperCase()]: livePrice },
      });
      if (evalRes.tradesClosed > 0) {
        for (const closedId of evalRes.closedTradeIds) {
          await this.generateSelfReflection(closedId, symbol);
        }
      }
    } catch {
      // Ignore evaluation errors during rapid tick intervals
    }

    // Rate limit trade proposals to once every 15 seconds per symbol
    const lastAttempt = this.lastTradeAttempt.get(symbol) ?? 0;
    if (Date.now() - lastAttempt < 15000) {
      return;
    }

    // 3. Resolve latest completed candle and indicator evidence
    //
    // `lot_size` is read here rather than hardcoded at the execution site. It used to be
    // `symbol === "NIFTY50" ? 50 : 25`, which is both stale and unreachable by the revision
    // that fixes it: lot sizes live in `instruments` precisely so a change is a data change
    // (migrations 019/020 exist to correct them), and `assessContractSize` is there to catch a
    // stale one. At NIFTY near 24,000 that literal implied a Rs 12 lakh contract, which the
    // project's own `contractNotional` check grades BELOW_REGULATORY_MINIMUM against SEBI's
    // Rs 15 lakh floor -- so the agent was sizing every position to a value the rest of the
    // codebase is written to reject.
    const client = await this.database.connect();
    let instId = "";
    let lotSize = 0;
    try {
      const instRes = await client.query<{ id: string; lot_size: string | number }>(
        "SELECT id, lot_size FROM instruments WHERE symbol = $1 LIMIT 1",
        [symbol],
      );
      instId = instRes.rows[0]?.id ?? "";
      lotSize = Number(instRes.rows[0]?.lot_size ?? 0);
    } finally {
      client.release();
    }
    if (!instId) return;

    const ctx = await this.marketContextRepo.findLatestCompleted({ instrumentId: instId, timeframe });
    if (!ctx) return;

    // Stops above were still evaluated from live prices. New proposals, however, must not mix a
    // live quote with indicators and patterns from an old completed bar. The paper bot already
    // enforces this boundary; the autonomous path previously did not.
    const contextFreshness = assessDataFreshness({
      symbol: `${symbol} ${timeframe}`,
      latestBarCloseTime: ctx.candle.closeTime,
      now,
      maxAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES + barLengthMinutes(timeframe),
    });
    if (!contextFreshness.fresh) {
      this.recordThought({
        id: `th-${Date.now()}-stale-context`,
        timestamp: ts,
        symbol,
        action: "MONITORING",
        confidence: 0,
        message: `Agent skipped new proposals: ${contextFreshness.explanation}`,
        details: {
          reason: "STALE_MARKET_CONTEXT",
          freshnessReason: contextFreshness.reason,
          timeframe,
          latestBarCloseTime: ctx.candle.closeTime.toISOString(),
          ageMinutes: contextFreshness.ageMinutes,
        },
      });
      return;
    }

    // 4. Perform Multi-Modal AI Analysis (Indicators + Pattern + News Sentiment)
    //
    // Matching on the code alone picked whichever algorithm version sorted first,
    // so a seeded or experimental snapshot could stand in for the production one.
    // The strategies pin this version through their configuration; the agent has no
    // configuration, so it pins it here.
    const rsiObj = ctx.indicators.find((i) => i.code === "RSI" && i.algorithmVersion === PRODUCTION_INDICATOR_VERSION);
    const bbObj = ctx.indicators.find((i) => i.code === "BOLLINGER_BANDS" && i.algorithmVersion === PRODUCTION_INDICATOR_VERSION);
    const latestPattern = ctx.patterns[0];

    // Reads `value`, the key RSI snapshots are actually written under. This read
    // `values["rsi"]`, which is never present, so every RSI branch below saw a
    // hardcoded 50 and none of them could fire -- while the emitted thought still
    // claimed the setup was "aligned across RSI, Bollinger Bands, and News
    // Sentiment". Fixing the key makes the agent's RSI reasoning real for the first
    // time, so its confidence numbers now differ from previous runs.
    const rsiVal = rsiObj ? Number(rsiObj.values["value"] ?? 50) : 50;
    const bbUpper = bbObj ? Number(bbObj.values["upper"] ?? livePrice * 1.02) : livePrice * 1.02;
    const bbLower = bbObj ? Number(bbObj.values["lower"] ?? livePrice * 0.98) : livePrice * 0.98;

    // Query live rolling news sentiment from repository
    const newsSummary = await this.newsRepo.getRollingSentimentAverage(symbol, 12);
    const newsSentiment = newsSummary.articleCount > 0 ? newsSummary.averageScore : 0;
    const newsLabel = newsSummary.articleCount === 0
      ? "NEUTRAL (No breaking news in last 12h)"
      : newsSentiment <= -0.5
        ? `HIGH RISK / BEARISH (${newsSentiment.toFixed(2)} score across ${newsSummary.articleCount} articles)`
        : newsSentiment >= 0.2
          ? `POSITIVE (${newsSentiment.toFixed(2)} score across ${newsSummary.articleCount} articles)`
          : `NEUTRAL (${newsSentiment.toFixed(2)} score across ${newsSummary.articleCount} articles)`;

    let hasHeadlineHeat = false;
    let headlineEventNames: string[] = [];
    let hasScheduledMacroEvent = false;
    if (this.checkMacroEvents) {
      const macroRes = await this.checkMacroEvents.execute();
      // Soft −10 uses headline heat only. Scheduled calendar is a hard gate downstream.
      hasHeadlineHeat = macroRes.hasHeadlineHeat;
      headlineEventNames = macroRes.headlineEvents;
      hasScheduledMacroEvent = macroRes.hasScheduledEvent;
    }

    // Institutional Data
    //
    // Reads the most recent *published* print rather than today's row. Flows for
    // session D are only collected after D's close (18:30 IST), so the previous
    // `WHERE date = today` lookup returned zero rows for the entire trading day
    // and this whole signal was dead every time the agent actually ran.
    let flowBias: InstitutionalFlowBias = { adjustment: 0, reasoning: null };
    /**
     * The same verdict for a short thesis.
     *
     * `institutionalFlowBias` weights outflows 1.5x relative to inflows, because a thesis the
     * tape contradicts should lose more than an agreeing tape wins. Negating the flows is what
     * carries that asymmetry across to the other side: against a short, *inflows* become the
     * adverse reading and take the 1.5x. Flipping the sign of `flowBias.adjustment` would not --
     * it would hand the short side the milder weighting on every print, which is a systematic
     * bias toward shorting dressed up as symmetry.
     */
    let shortFlowBias: InstitutionalFlowBias = { adjustment: 0, reasoning: null };
    try {
      const res = await this.database.query<{ fii: string | null; dii: string | null; date: Date }>(
        `SELECT fii_cash_net_cr AS fii, dii_cash_net_cr AS dii, date
         FROM institutional_flows
         WHERE date >= CURRENT_DATE - $1::int
         ORDER BY date DESC
         LIMIT 1`,
        [INSTITUTIONAL_FLOW_MAX_AGE_DAYS],
      );
      const row = res.rows[0];
      if (row) {
        const toNumber = (value: string | null): number | null => {
          if (value === null) return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const fii = toNumber(row.fii);
        const dii = toNumber(row.dii);
        const negate = (value: number | null): number | null => (value === null ? null : -value);
        flowBias = institutionalFlowBias(fii, dii);
        shortFlowBias = institutionalFlowBias(negate(fii), negate(dii));
      }
    } catch (e) {
      console.warn("Error fetching institutional data:", e);
    }

    // Index-driver tape (breadth / concentration). Soft context only — thin Yahoo
    // coverage or unsupported symbols leave the term unchecked, same as missing FII.
    let longDriverTape: InstitutionalFlowBias = { adjustment: 0, reasoning: null };
    let shortDriverTape: InstitutionalFlowBias = { adjustment: 0, reasoning: null };
    let driverTapeMetrics: DriverTapeMetrics | null = null;
    try {
      const driverTape = await loadIndexDriverTape(symbol);
      if (driverTape?.tape) {
        driverTapeMetrics = driverTape.tape;
        longDriverTape = scoreDriverTapeBias("LONG", driverTape.tape);
        shortDriverTape = scoreDriverTapeBias("SHORT", driverTape.tape);
      }
    } catch (e) {
      console.warn("Error fetching index-driver tape:", e);
    }

    const openTrades = await this.paperTradeRepo.listOpenByAccount(account.id);
    const existingTrades = openTrades.filter((t) => t.instrumentId === instId);

    // EMERGENCY CIRCUIT BREAKER RULE 3: Panic Emergency Exit on <= -0.7
    //
    // Every position here is an option, so the exit has to be priced in **premium** space. This
    // used to close at `exitPrice: livePrice` -- the underlying's index level, around 24,590
    // against a premium of maybe 200 -- which books a fabricated ~24,000-point gain per unit on
    // what is supposed to be an emergency liquidation. It is the same defect as the model mark
    // that once reported +Rs 2,032 on a position down Rs 651, and it was reachable for any option
    // position on the ticked instrument, including ones the bot opened.
    //
    // A contract with no observed quote is **not** closed. Refusing is the conservative action:
    // an unpriceable position stays open and says so, where a guessed exit writes a wrong
    // realized P&L into the ledger permanently.
    if (newsSentiment <= -0.7 && existingTrades.length > 0) {
      for (const t of existingTrades) {
        const exit = await this.resolvePanicExitPremium(t);
        if (exit === null) {
          this.recordThought({
            id: `th-${Date.now()}-panic-unpriced`,
            timestamp: ts,
            symbol,
            action: "MONITORING",
            confidence: 99,
            message: `🚨 CIRCUIT BREAKER RULE 3 wanted to liquidate trade #${t.id.substring(0, 8)} on `
              + `extreme negative sentiment (${newsSentiment.toFixed(2)}), but no observed quote `
              + "exists for its contract. Left open rather than closed at a guessed price.",
            details: { tradeId: t.id, reason: "NO_OBSERVED_CONTRACT_QUOTE", newsSentiment },
          });
          continue;
        }
        await this.paperTradeRepo.close({
          paperTradeId: t.id,
          exitPrice: exit.premium,
          exitReason: "MANUAL",
          closedAt: new Date(),
          // The brokerage model, on the premium that is actually being sold. Charging a flat
          // constant here is what made a breaker exit cost a different amount from every other
          // exit on the same contract.
          exitFees: Number(calculateExitFees(exit.premium, t.quantity).total.toFixed(2)),
          // Zero: `exit.premium` is already the bid where one was observed, so the spread has
          // been crossed. A slippage estimate on top charges for crossing it twice.
          exitSlippage: 0,
          details: {
            reason: "EMERGENCY_PANIC_CIRCUIT_BREAKER",
            newsSentiment,
            exitPriceSource: exit.source,
            underlyingAtExit: livePrice,
          },
        });
        this.recordThought({
          id: `th-${Date.now()}-panic`,
          timestamp: ts,
          symbol,
          action: "EXECUTING",
          confidence: 99,
          message: `🚨 EMERGENCY CIRCUIT BREAKER RULE 3 TRIGGERED: Extreme negative news sentiment `
            + `(${newsSentiment.toFixed(2)}). Liquidating trade #${t.id.substring(0, 8)} at premium `
            + `₹${exit.premium.toFixed(2)} (${exit.source}).`,
          details: {
            tradeId: t.id,
            exitReason: "EMERGENCY_PANIC",
            newsSentiment,
            exitPremium: exit.premium,
            exitPriceSource: exit.source,
          },
        });
        await this.generateSelfReflection(t.id, symbol);
      }
      return;
    }

    // EMERGENCY CIRCUIT BREAKER RULE 2: Dynamic Stop-Loss Tightening on < -0.3
    //
    // Applies to both sides. It was `if (t.side === "LONG")`, so a short position in the
    // account was silently exempt from the breaker -- and since the execution path below could
    // book a SHORT, the agent was capable of opening exactly the position this rule could not
    // protect. For a short, "tighter" means moving the stop *down* toward the price.
    if (newsSentiment < -0.3 && newsSentiment > -0.7 && existingTrades.length > 0 && this.paperTradeRepo.updateStopLoss) {
      for (const t of existingTrades) {
        const tightSl = Number((t.side === "LONG" ? livePrice * 0.995 : livePrice * 1.005).toFixed(2));
        // Only ever moves the stop closer to the price, and never through it.
        const isTighter = t.side === "LONG"
          ? t.stopLoss < tightSl && tightSl < livePrice
          : t.stopLoss > tightSl && tightSl > livePrice;
        if (!isTighter) continue;
        await this.paperTradeRepo.updateStopLoss(t.id, tightSl, `Circuit Breaker Rule 2 (Sentiment ${newsSentiment.toFixed(2)})`);
        this.recordThought({
          id: `th-${Date.now()}-sl-tighten`,
          timestamp: ts,
          symbol,
          action: "MONITORING",
          confidence: 85,
          message: `🛡️ CIRCUIT BREAKER RULE 2: Negative market sentiment (${newsSentiment.toFixed(2)}). Tightened ${t.side} Stop Loss from ₹${t.stopLoss} to ₹${tightSl} (0.5% trail).`,
          details: { tradeId: t.id, side: t.side, oldSl: t.stopLoss, newSl: tightSl, newsSentiment },
        });
        t.stopLoss = tightSl;
      }
    }

    /**
     * Both directions are scored from the same evidence, and the better-supported one wins.
     *
     * The terms themselves live in `directional-setup-score.ts`. What used to be here was a run
     * of `confidence += n` statements written entirely for a long, after which `side` was picked
     * from the latest pattern's direction -- so a bearish pattern flipped the position while
     * keeping a score computed for the opposite thesis. Extracting the scorer is what made the
     * two theses expressible at all; keeping it pure is what makes them testable.
     *
     * The macro-event caution deserves its original note, which is about sizing rather than
     * direction: it was a -50 circuit breaker described as freezing trading, and measured against
     * the stored newswire on 2026-08-05 its keyword match fires on 7 of 9 days (78%) -- even
     * tightened to unambiguous phrases and five corroborating articles, still 4 of 9. Financial
     * media discusses monetary policy continuously, so the detector mostly reports that a
     * newswire exists, and a -50 gate on four days in five suppresses idea generation rather than
     * avoiding volatility crush. A real freeze needs a calendar of *scheduled* events, which this
     * project does not have -- see docs/pending-work.md 2.4.
     */
    const smcConfluence = measureSmcConfluence(ctx);
    const scoreInputWithoutTape = {
      rsi: rsiVal,
      livePrice,
      bollingerUpper: bbUpper,
      bollingerLower: bbLower,
      pattern: latestPattern
        ? {
          code: latestPattern.code,
          direction: latestPattern.direction,
          confidence: latestPattern.confidence,
        }
        : null,
      // The short verdict is the same tested function on negated flows, which is what makes
      // *inflows* carry the 1.5x against a short. A sign flip would not: the asymmetry would
      // then favour the short side on every reading.
      flowBias: { long: flowBias, short: shortFlowBias },
      smcBias: { long: smcConfluence.long, short: smcConfluence.short },
      newsSentiment,
      newsLabel,
      hasHeadlineHeat,
      headlineEventNames,
    };
    const scoreWithoutTape = scoreDirectionalSetup(scoreInputWithoutTape);
    const setupScore = scoreDirectionalSetup({
      ...scoreInputWithoutTape,
      driverTapeBias: { long: longDriverTape, short: shortDriverTape },
    });
    const confidence = setupScore.confidence;
    const reasoning = setupScore.reasoning;

    // No memory recall term. This previously embedded the context with
    // `generatePseudoEmbedding` -- a string hash, not a semantic encoding -- took the
    // 2 nearest journal reflections with no similarity threshold, and moved
    // confidence by +/-15 per hit while telling the user it had "found a highly
    // similar past setup". With hash noise as the metric and 2 rows in the table,
    // the same rows came back for every context, so it was a constant bias on every
    // decision presented as recall. Restoring it requires a real embedding model, a
    // similarity floor, and a corpus worth retrieving from; see
    // docs/next-session-brief.md 3.6.

    // The floor and ceiling are applied per thesis inside the scorer, so there is nothing to
    // clamp here.

    // Log AI Thought
    const thought: AiBrainThought = {
      id: `th-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: ts,
      symbol,
      action: confidence >= 80 ? "PROPOSING" : "ANALYZING",
      confidence,
      // The winning side is named. The old message asserted the setup was "aligned across RSI,
      // Bollinger Bands, and News Sentiment" without saying which way, which read as bullish
      // regardless of what the score meant.
      message: confidence >= 80
        ? `🔥 HIGH CONFIDENCE ${setupScore.side} SETUP (${confidence}%): ${symbol} aligned across RSI, `
          + "Bollinger Bands, and News Sentiment. Initiating trade proposal."
        : `Scanning ${symbol} @ ₹${livePrice.toFixed(2)}. Best thesis ${setupScore.side} at ${confidence}% `
          + `(long ${setupScore.longConfidence}% / short ${setupScore.shortConfidence}%, threshold 80%). `
          + "Waiting for stronger multi-modal confluence.",
      details: {
        rsi: rsiVal.toFixed(1),
        pattern: latestPattern?.code ?? "NONE",
        newsSentiment: newsLabel,
        // Both scores, so a 79/78 near-tie is distinguishable from a 79/20 conviction.
        side: setupScore.side,
        longConfidence: setupScore.longConfidence,
        shortConfidence: setupScore.shortConfidence,
        hasScheduledMacroEvent,
        hasHeadlineHeat,
        driverTape: {
          long: longDriverTape,
          short: shortDriverTape,
        },
        smc: {
          algorithmVersion: SMC_ALGORITHM_VERSION,
          long: smcConfluence.long,
          short: smcConfluence.short,
          signals: smcConfluence.signals,
        },
        reasoning,
      },
    };
    this.recordThought(thought);

    // Persist both thesis readings, including zero adjustments, so the selected population has
    // a real control group. Exact candle/idea/trade links make eventual outcomes joinable.
    const driverTapeRepository = new PostgresDriverTapeAdjustmentRepository(this.database);
    const driverTapeAdjustmentIds: string[] = [];
    if (driverTapeMetrics !== null) {
      try {
        for (const thesisSide of ["LONG", "SHORT"] as const) {
          const tape = thesisSide === "LONG" ? longDriverTape : shortDriverTape;
          driverTapeAdjustmentIds.push(await driverTapeRepository.insert({
            underlyingSymbol: symbol,
            thesisSide,
            adjustment: tape.adjustment,
            reasoning: tape.reasoning ?? "Driver tape measured; thresholds produced no adjustment.",
            metrics: driverTapeMetrics,
            preAdjustmentConfidence: thesisSide === "LONG"
              ? scoreWithoutTape.longConfidence
              : scoreWithoutTape.shortConfidence,
            resultingConfidence: thesisSide === "LONG"
              ? setupScore.longConfidence
              : setupScore.shortConfidence,
            resultingSide: setupScore.side,
            thoughtId: thought.id,
            sourceCandleId: ctx.candle.id,
          }));
        }
      } catch (e) {
        console.warn("driver_tape_adjustments insert failed:", e);
      }
    }

    // 5. If confidence >= 80%, check margin and execute local paper trade!
    if (confidence >= 80) {
      this.lastTradeAttempt.set(symbol, Date.now());

      // The measured side gate. A qualifying SHORT is recorded in full and not traded: the
      // measurement behind `AGENT_EXECUTABLE_SIDES` shows the short gate selecting worse than its
      // own unconditional baseline on both instruments tested. Journalled rather than dropped, so
      // the population that *would* have been traded stays visible and the gate can be re-measured
      // against it later.
      if (!AGENT_EXECUTABLE_SIDES.includes(setupScore.side)) {
        this.recordThought({
          id: `th-${Date.now()}-side-gated`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "MONITORING",
          confidence,
          message: `${setupScore.side} setup qualified at ${confidence}% but ${setupScore.side} is not an `
            + "executable side: measured gated hit rate falls below both break-even and its own "
            + "unconditional baseline. Recorded, not traded.",
          details: {
            gatedSide: setupScore.side,
            executableSides: [...AGENT_EXECUTABLE_SIDES],
            longConfidence: setupScore.longConfidence,
            shortConfidence: setupScore.shortConfidence,
            reasoning,
          },
        });
        return;
      }

      if (existingTrades.length > 0) {
        this.recordThought({
          id: `th-${Date.now()}-skip`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "MONITORING",
          confidence,
          message: `Position already OPEN for ${symbol}. Monitoring active trade rules instead of opening duplicate position.`,
          details: { openTradesCount: openTrades.length },
        });
        return;
      }

      // Resolve active strategy version
      let stratVerId = "";
      const client2 = await this.database.connect();
      try {
        const verRes = await client2.query<{ id: string }>("SELECT id FROM strategy_versions WHERE is_active = TRUE LIMIT 1");
        stratVerId = verRes.rows[0]?.id ?? "";
      } finally {
        client2.release();
      }
      if (!stratVerId) return;

      /**
       * The side the score was computed for, not a direction chosen after the fact.
       *
       * `side` used to be `latestPattern?.direction === "BEARISH" ? "SHORT" : "LONG"`, read
       * *after* a confidence number that was long-biased in every term -- so the agent's most
       * confident shorts were its most confidently bullish reads. Both theses are now scored
       * separately and this is whichever one won, carrying its own number.
       */
      const side: TradeSide = setupScore.side;

      // Volatility-scaled bracket. The production ATR snapshot is required: a
      // stop sized without a volatility measurement is a guess, and the rest of
      // this codebase deliberately refuses to trade on fabricated numbers.
      const atrObj = ctx.indicators.find((i) => i.code === "ATR" && i.algorithmVersion === PRODUCTION_INDICATOR_VERSION);
      const atrValue = atrObj ? Number(atrObj.values["value"] ?? Number.NaN) : Number.NaN;
      if (!Number.isFinite(atrValue) || atrValue <= 0) {
        this.recordThought({
          id: `th-${Date.now()}-noatr`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "MONITORING",
          confidence,
          message: `Setup qualified at ${confidence}% confidence, but no production ATR(14) snapshot exists for ${symbol} on ${timeframe}. Skipping execution rather than guessing a stop distance.`,
          details: { timeframe, missingIndicator: "ATR", algorithmVersion: PRODUCTION_INDICATOR_VERSION },
        });
        return;
      }

      const slDist = atrValue * AGENT_ATR_STOP_MULTIPLE;
      const tpDist = slDist * AGENT_REWARD_RISK_MULTIPLE;
      const stopLoss = side === "LONG" ? Number((livePrice - slDist).toFixed(2)) : Number((livePrice + slDist).toFixed(2));
      const targetPrice = side === "LONG" ? Number((livePrice + tpDist).toFixed(2)) : Number((livePrice - tpDist).toFixed(2));

      // Sizing, strike selection and fees all belong to the entry gate now, so nothing is
      // derived here. `lotSize` is read only to surface a stale configuration in the journal --
      // `PrepareOptionEntry` uses the same column through the tested `lotsToQuantity` path.
      const assessment = Number.isInteger(lotSize) && lotSize > 0
        ? assessContractSize(lotSize, livePrice)
        : null;
      if (assessment !== null && assessment.verdict !== "PLAUSIBLE") {
        // Surfaced, not blocked: the notional band is a staleness heuristic, not a rule.
        reasoning.push(`Contract-size check: ${assessment.explanation}`);
      }

      try {
        const proposal = await this.tradeIdeaRepo.saveProposal({
          instrumentId: instId,
          strategyVersionId: stratVerId,
          sourceCandleId: ctx.candle.id,
          side,
          entryPrice: livePrice,
          stopLoss,
          targetPrice,
          riskReward: AGENT_REWARD_RISK_MULTIPLE,
          confidence: confidence / 100,
          reasoning,
          evidence: {
            source: "AI_AUTONOMOUS_AGENT",
            newsSentiment,
            rsiVal,
            atrValue,
            atrStopMultiple: AGENT_ATR_STOP_MULTIPLE,
            rewardRiskMultiple: AGENT_REWARD_RISK_MULTIPLE,
            configuredLotSize: lotSize,
            contractSizeVerdict: assessment?.verdict ?? "UNKNOWN",
            // Recorded so a review can ask whether the losing thesis was nearly as strong.
            longConfidence: setupScore.longConfidence,
            shortConfidence: setupScore.shortConfidence,
          },
          expiresAt: new Date(Date.now() + 3600000 * 4),
          evidenceItems: [],
        });

        /**
         * The idea becomes an **option** position, through the shared gated path.
         *
         * This used to be `openFromTradeIdea({ quantity: lotSize, fillPrice: livePrice })`, which
         * booked a cash-style position at the index's own level -- 75 units of NIFTY50 at ~24,590.
         * That instrument cannot be bought, so every P&L it produced was measured against a
         * contract that does not exist. `side` here is the *thesis*; the entry gate turns LONG
         * into a call and SHORT into a put, and the position is long the option either way.
         *
         * `OpenOptionPositionFromIdea` also applies `evaluateRisk`, which the agent previously
         * had no contact with at all -- so the one component trading unattended was the one with
         * no concurrent-position, daily-loss or drawdown brake.
         */
        const placement = await this.openOptionPosition.execute({
          accountId: account.id,
          instrumentId: instId,
          tradeIdeaId: proposal.id,
          lots: 1,
          now: new Date(),
          notes: `AI Autonomous Execution (${confidence}% ${side} confidence). Confluence: ${reasoning[0]}`,
        });

        if (driverTapeAdjustmentIds.length > 0) {
          await driverTapeRepository.linkToDecision(
            driverTapeAdjustmentIds,
            proposal.id,
            placement.opened ? placement.trade.id : null,
          ).catch((error: unknown) => {
            console.warn("driver_tape_adjustments decision link failed:", error);
          });
        }

        if (!placement.opened) {
          // A refusal is reported, never silently dropped: "the gate refused" and "no setup
          // qualified" are different observations and must not read the same in the journal.
          this.recordThought({
            id: `th-${Date.now()}-refused`,
            timestamp: new Date().toISOString(),
            symbol,
            action: "MONITORING",
            confidence,
            message: `Setup qualified at ${confidence}% (${side}) but the entry gate refused: `
              + `${placement.reason}. ${placement.explanation}`,
            details: {
              tradeIdeaId: proposal.id,
              reason: placement.reason,
              ...(placement.reasons ? { reasons: placement.reasons } : {}),
              ...(placement.unchecked ? { unchecked: placement.unchecked } : {}),
            },
          });
          return;
        }

        const contract = `${placement.contract.underlyingSymbol} `
          + `${placement.contract.optionExpiry.toISOString().slice(0, 10)} `
          + `${placement.contract.optionStrike} ${placement.contract.optionType}`;
        this.recordThought({
          id: `th-${Date.now()}-exec`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "EXECUTING",
          confidence,
          // Premiums, not index levels. The old message quoted the underlying's price as though
          // it were the fill.
          message: `⚡ AUTO-EXECUTE ${side} via ${contract}: ${placement.quantity} @ premium `
            + `₹${placement.fillPremium.toFixed(2)} (Trade #${placement.trade.id.substring(0, 8)}). `
            + `SL: ₹${placement.stopPremium.toFixed(2)} | TP: ₹${placement.targetPremium.toFixed(2)}.`,
          details: {
            tradeId: placement.trade.id,
            thesis: side,
            contract,
            fillPremium: placement.fillPremium,
            stopPremium: placement.stopPremium,
            targetPremium: placement.targetPremium,
            quantity: placement.quantity,
            entryFees: placement.entryFees,
            underlyingEntry: livePrice,
            unchecked: placement.unchecked,
          },
        });
      } catch (err) {
        this.recordThought({
          id: `th-${Date.now()}-err`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "MONITORING",
          confidence,
          message: `Failed to execute trade proposal: ${err instanceof Error ? err.message : String(err)}`,
          details: {},
        });
      }
    }
  }

  public async generateSelfReflection(tradeId: string, symbol: string): Promise<void> {
    const client = await this.database.connect();
    try {
      const res = await client.query<{
        id: string;
        instrument_id: string;
        side: TradeSide;
        quantity: string;
        realized_pnl: string;
        exit_reason: string | null;
        entry_price: string;
        exit_price: string | null;
        stop_loss: string;
        target_price: string;
        opened_at: Date;
        closed_at: Date | null;
        timeframe: string | null;
      }>(`
        SELECT paper_trades.id, paper_trades.instrument_id, paper_trades.side, paper_trades.quantity,
               paper_trades.realized_pnl, paper_trades.exit_reason, paper_trades.entry_price,
               paper_trades.exit_price, paper_trades.stop_loss, paper_trades.target_price,
               paper_trades.opened_at, paper_trades.closed_at, source_candle.timeframe
        FROM paper_trades
        LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
        LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
        WHERE paper_trades.id = $1
      `, [tradeId]);

      const row = res.rows[0];
      if (!row) return;
      // A review measures a finished trade. Reviewing one that has not closed would
      // have to invent an exit price, which is the class of thing this replaced.
      if (row.closed_at === null || row.exit_price === null) return;

      const pnl = Number(row.realized_pnl ?? 0);
      const reviewRepository = new PostgresTradeReviewRepository(client);
      const holdingPeriod = await reviewRepository.findHoldingPeriodCandles({
        instrumentId: row.instrument_id,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        preferredTimeframe: row.timeframe,
      });

      const review = buildTradeReview({
        tradeId: row.id,
        side: row.side,
        quantity: Number(row.quantity),
        entryPrice: Number(row.entry_price),
        exitPrice: Number(row.exit_price),
        stopLoss: Number(row.stop_loss),
        targetPrice: Number(row.target_price),
        realizedPnl: pnl,
        exitReason: row.exit_reason,
        candles: holdingPeriod.candles,
        observedTimeframe: holdingPeriod.timeframe,
      });
      await reviewRepository.save(review);

      // The journal text is now assembled from the measured review rather than
      // written from a template. The previous version inferred "hit Target Profit"
      // from a positive P&L while ignoring the exit_reason in its own query, and
      // proposed the same fixed stop-tightening rule for every loss based on a
      // volume condition it never evaluated.
      const outcome = review.outcome === "LOSS" ? "LOSS" : "WIN";
      const analysis = review.observations.join(" ");
      const improvementRule = review.proposedResearchTags.length > 0
        ? `RESEARCH TAGS (aggregate before acting; these change nothing on their own): ${review.proposedResearchTags.join(", ")}.`
        : "No research tag triggered: geometry and outcome were unremarkable.";

      const reflection: AiReflectionLog = {
        id: `ref-${row.id}`,
        timestamp: new Date(row.closed_at).toISOString(),
        tradeId: row.id,
        symbol,
        side: row.side,
        pnl,
        outcome,
        analysis,
        improvementRule,
      };

      // Any earlier entry for this trade is removed first: historical reflections were
      // keyed by `ref-<timestamp>-<random>`, so a re-review could not overwrite them
      // and superseded text would linger on the dashboard alongside the new entry.
      //
      // Saved without an embedding. The reflection text is real and worth keeping;
      // a vector for it is not available until a real embedding model exists, and
      // a fabricated one is worse than none.
      await this.aiJournalRepo.deleteByTradeId(row.id);
      await this.aiJournalRepo.saveReflection(reflection);

      this.recordThought({
        id: `th-${Date.now()}-learn`,
        timestamp: row.closed_at ? new Date(row.closed_at).toISOString() : new Date().toISOString(),
        symbol,
        action: "LEARNING",
        confidence: 95,
        // Reports the measured excursions, which is what the review actually
        // establishes. `confidence: 95` above is a display artefact of the thought
        // stream, not a claim about this review.
        message: `🧠 TRADE REVIEW RECORDED (${review.outcome} ${review.realizedR}R): ran `
          + `${review.maximumFavourableExcursionR ?? "unmeasured"}R in favour and `
          + `${review.maximumAdverseExcursionR ?? "unmeasured"}R against before closing `
          + `${review.exitReason ?? "with no recorded reason"}.`,
        details: {
          tradeId: row.id,
          outcome: review.outcome,
          pnl,
          realizedR: review.realizedR,
          maximumAdverseExcursionR: review.maximumAdverseExcursionR,
          maximumFavourableExcursionR: review.maximumFavourableExcursionR,
          observedTimeframe: review.observedTimeframe,
          candlesObserved: review.candlesObserved,
          proposedResearchTags: review.proposedResearchTags,
        },
      });
    } finally {
      client.release();
    }
  }

  private async listClosedTrades(accountId: string, period: string): Promise<PaperTrade[]> {
    const client = await this.database.connect();
    try {
      let resolvedId = accountId;
      if (!resolvedId || !resolvedId.includes("-")) {
        const accRes = await client.query<{ id: string }>("SELECT id FROM paper_accounts WHERE name = $1 LIMIT 1", [accountId]);
        if (accRes.rows[0]?.id) {
          resolvedId = accRes.rows[0].id;
        } else {
          const firstAcc = await client.query<{ id: string }>("SELECT id FROM paper_accounts LIMIT 1");
          resolvedId = firstAcc.rows[0]?.id ?? accountId;
        }
      }

      let timeFilter = "AND pt.closed_at >= NOW() - INTERVAL '1 day'";
      if (period === "1h") timeFilter = "AND pt.closed_at >= NOW() - INTERVAL '1 hour'";
      else if (period === "1m" || period === "1mo") timeFilter = "AND pt.closed_at >= NOW() - INTERVAL '30 days'";
      else if (period === "all") timeFilter = "";

      const res = await client.query<{
        id: string;
        account_id: string;
        trade_idea_id: string | null;
        instrument_id: string;
        instrument_symbol?: string;
        timeframe: string | null;
        side: TradeSide;
        status: "CLOSED";
        quantity: string;
        entry_price: string;
        stop_loss: string;
        target_price: string;
        opened_at: Date;
        closed_at: Date;
        exit_price: string;
        exit_reason: any;
        realized_pnl: string;
        fees: string;
        slippage: string;
        notes: string;
      }>(`
        SELECT pt.*, i.symbol as instrument_symbol
        FROM paper_trades pt
        LEFT JOIN instruments i ON i.id = pt.instrument_id
        WHERE pt.account_id = $1 AND pt.status = 'CLOSED' ${timeFilter}
        ORDER BY pt.closed_at DESC
      `, [resolvedId]);

      return res.rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        tradeIdeaId: r.trade_idea_id,
        instrumentId: r.instrument_id,
        instrumentSymbol: (r as any).instrument_symbol ?? "NIFTY50",
        timeframe: r.timeframe,
        side: r.side,
        status: "CLOSED",
        quantity: Number(r.quantity),
        entryPrice: Number(r.entry_price),
        stopLoss: Number(r.stop_loss),
        targetPrice: Number(r.target_price),
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        exitPrice: Number(r.exit_price),
        exitReason: r.exit_reason,
        realizedPnl: Number(r.realized_pnl),
        fees: Number(r.fees),
        slippage: Number(r.slippage),
        notes: r.notes ?? "",
      }));
    } finally {
      client.release();
    }
  }
}
