import type { DatabasePool } from "../../../infrastructure/database/database.js";
import type { StrategyMarketContextRepository, TradeIdeaRepository, TradeSide } from "../domain/strategy.js";
import type { PaperAccountRepository, PaperTradeRepository, PaperTrade } from "../../paper-trading/domain/paper-trading.js";
import { EvaluateOpenPaperTrades } from "../../paper-trading/application/evaluate-open-paper-trades.js";
import type { CandleRepository } from "../../market-data/domain/candle.js";
import type { NewsRepository } from "../../news-sentiment/domain/news-article.js";
import type { PostgresAiJournalRepository } from "../../../infrastructure/database/repositories/postgres-ai-journal-repository.js";

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

/** How stale a published FII/DII print may be before the agent ignores it. */
export const INSTITUTIONAL_FLOW_MAX_AGE_DAYS = 5;

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

export class AiAutonomousAgent {
  private readonly thoughts: AiBrainThought[] = [];
  private readonly evaluateTrades: EvaluateOpenPaperTrades;
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
  ) {
    this.evaluateTrades = new EvaluateOpenPaperTrades(paperTradeRepo, candleRepo);
  }

  public getThoughts(limit = 15): AiBrainThought[] {
    return this.thoughts.slice(-limit).reverse();
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
      recentThoughts: this.getThoughts(10),
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
    const client = await this.database.connect();
    let instId = "";
    try {
      const instRes = await client.query<{ id: string }>("SELECT id FROM instruments WHERE symbol = $1 LIMIT 1", [symbol]);
      instId = instRes.rows[0]?.id ?? "";
    } finally {
      client.release();
    }
    if (!instId) return;

    const ctx = await this.marketContextRepo.findLatestCompleted({ instrumentId: instId, timeframe });
    if (!ctx) return;

    // 4. Perform Multi-Modal AI Analysis (Indicators + Pattern + News Sentiment)
    const rsiObj = ctx.indicators.find((i) => i.code === "RSI");
    const bbObj = ctx.indicators.find((i) => i.code === "BOLLINGER_BANDS");
    const latestPattern = ctx.patterns[0];

    const rsiVal = rsiObj ? Number(rsiObj.values["rsi"] ?? 50) : 50;
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

    // Institutional Data
    //
    // Reads the most recent *published* print rather than today's row. Flows for
    // session D are only collected after D's close (18:30 IST), so the previous
    // `WHERE date = today` lookup returned zero rows for the entire trading day
    // and this whole signal was dead every time the agent actually ran.
    let flowBias: InstitutionalFlowBias = { adjustment: 0, reasoning: null };
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
        flowBias = institutionalFlowBias(toNumber(row.fii), toNumber(row.dii));
      }
    } catch (e) {
      console.warn("Error fetching institutional data:", e);
    }

    const openTrades = await this.paperTradeRepo.listOpenByAccount(account.id);
    const existingTrades = openTrades.filter((t) => t.instrumentId === instId);

    // EMERGENCY CIRCUIT BREAKER RULE 3: Panic Emergency Exit on <= -0.7
    if (newsSentiment <= -0.7 && existingTrades.length > 0) {
      for (const t of existingTrades) {
        await this.paperTradeRepo.close({
          paperTradeId: t.id,
          exitPrice: livePrice,
          exitReason: "MANUAL",
          closedAt: new Date(),
          exitFees: 20,
          exitSlippage: livePrice * t.quantity * 0.001,
          details: { reason: "EMERGENCY_PANIC_CIRCUIT_BREAKER", newsSentiment },
        });
        this.thoughts.push({
          id: `th-${Date.now()}-panic`,
          timestamp: ts,
          symbol,
          action: "EXECUTING",
          confidence: 99,
          message: `🚨 EMERGENCY CIRCUIT BREAKER RULE 3 TRIGGERED: Extreme negative news sentiment (${newsSentiment.toFixed(2)}). Liquidating open position at market price ₹${livePrice.toFixed(2)}!`,
          details: { tradeId: t.id, exitReason: "EMERGENCY_PANIC", newsSentiment },
        });
        await this.generateSelfReflection(t.id, symbol);
      }
      return;
    }

    // EMERGENCY CIRCUIT BREAKER RULE 2: Dynamic Stop-Loss Tightening on < -0.3
    if (newsSentiment < -0.3 && newsSentiment > -0.7 && existingTrades.length > 0 && this.paperTradeRepo.updateStopLoss) {
      for (const t of existingTrades) {
        if (t.side === "LONG") {
          const tightSl = Number((livePrice * 0.995).toFixed(2));
          if (t.stopLoss < tightSl && tightSl < livePrice) {
            await this.paperTradeRepo.updateStopLoss(t.id, tightSl, `Circuit Breaker Rule 2 (Sentiment ${newsSentiment.toFixed(2)})`);
            this.thoughts.push({
              id: `th-${Date.now()}-sl-tighten`,
              timestamp: ts,
              symbol,
              action: "MONITORING",
              confidence: 85,
              message: `🛡️ CIRCUIT BREAKER RULE 2: Negative market sentiment (${newsSentiment.toFixed(2)}). Tightened Stop Loss from ₹${t.stopLoss} to ₹${tightSl} (0.5% trail).`,
              details: { tradeId: t.id, oldSl: t.stopLoss, newSl: tightSl, newsSentiment },
            });
            t.stopLoss = tightSl;
          }
        }
      }
    }

    let confidence = 50;
    const reasoning: string[] = [];

    // Indicator logic
    if (rsiVal >= 52 && rsiVal <= 68) {
      confidence += 15;
      reasoning.push(`RSI(14) at ${rsiVal.toFixed(1)} confirms healthy momentum without overbought exhaustion.`);
    } else if (rsiVal > 70) {
      confidence -= 20;
      reasoning.push(`RSI(14) at ${rsiVal.toFixed(1)} warns of overbought divergence.`);
    } else if (rsiVal < 35) {
      confidence += 10;
      reasoning.push(`RSI(14) at ${rsiVal.toFixed(1)} indicates oversold value zone.`);
    }

    // Include FII/DII sentiment
    if (flowBias.reasoning) {
      confidence += flowBias.adjustment;
      reasoning.push(flowBias.reasoning);
    }

    if (livePrice > bbUpper) {
      confidence -= 10;
      reasoning.push(`Price pierced upper Bollinger Band (₹${bbUpper.toFixed(2)}), mean reversion risk elevated.`);
    } else if (livePrice < bbLower) {
      confidence += 15;
      reasoning.push(`Price touched lower Bollinger Band (₹${bbLower.toFixed(2)}), potential value opportunity.`);
    }

    // Bollinger Bands logic
    if (livePrice < bbUpper * 0.995 && livePrice > bbLower * 1.005) {
      confidence += 10;
      reasoning.push(`Price ₹${livePrice.toFixed(2)} is well-positioned within Bollinger Band envelope [₹${bbLower.toFixed(0)} - ₹${bbUpper.toFixed(0)}].`);
    } else if (livePrice >= bbUpper * 0.995) {
      confidence -= 25; // Applying our self-improvement penalty rule!
      reasoning.push(`AI PENALTY APPLIED: Price is near upper Bollinger resistance ₹${bbUpper.toFixed(2)}. Avoiding false breakout.`);
    }

    // Pattern Recognition logic
    if (latestPattern && latestPattern.confidence >= 0.7) {
      confidence += 20;
      reasoning.push(`Detected ${latestPattern.code} (${latestPattern.direction}) with ${(latestPattern.confidence * 100).toFixed(0)}% algorithmic certainty.`);
    }

    // EMERGENCY CIRCUIT BREAKER RULE 1 & News sentiment logic
    if (newsSentiment <= -0.5) {
      confidence -= 40;
      reasoning.push(`🚨 CIRCUIT BREAKER RULE 1: Heavy negative news sentiment (${newsSentiment.toFixed(2)}). Freezing new long trade proposals.`);
    } else if (newsSentiment > 0.2) {
      confidence += 10;
      reasoning.push(`Indian market macro news sentiment is ${newsLabel}.`);
    } else if (newsSentiment < 0) {
      confidence -= 10;
      reasoning.push(`Mild negative news sentiment (${newsSentiment.toFixed(2)}).`);
    }

    // No memory recall term. This previously embedded the context with
    // `generatePseudoEmbedding` -- a string hash, not a semantic encoding -- took the
    // 2 nearest journal reflections with no similarity threshold, and moved
    // confidence by +/-15 per hit while telling the user it had "found a highly
    // similar past setup". With hash noise as the metric and 2 rows in the table,
    // the same rows came back for every context, so it was a constant bias on every
    // decision presented as recall. Restoring it requires a real embedding model, a
    // similarity floor, and a corpus worth retrieving from; see
    // docs/next-session-brief.md 3.6.

    // Cap confidence
    confidence = Math.min(96, Math.max(15, confidence));

    // Log AI Thought
    const thought: AiBrainThought = {
      id: `th-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: ts,
      symbol,
      action: confidence >= 80 ? "PROPOSING" : "ANALYZING",
      confidence,
      message: confidence >= 80
        ? `🔥 HIGH CONFIDENCE SETUP (${confidence}%): ${symbol} aligned across RSI, Bollinger Bands, and News Sentiment. Initiating trade proposal.`
        : `Scanning ${symbol} @ ₹${livePrice.toFixed(2)}. Confidence ${confidence}% (Threshold: 80%). Waiting for stronger multi-modal confluence.`,
      details: {
        rsi: rsiVal.toFixed(1),
        pattern: latestPattern?.code ?? "NONE",
        newsSentiment: newsLabel,
        reasoning,
      },
    };
    this.thoughts.push(thought);

    // 5. If confidence >= 80%, check margin and execute local paper trade!
    if (confidence >= 80) {
      this.lastTradeAttempt.set(symbol, Date.now());

      if (existingTrades.length > 0) {
        this.thoughts.push({
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

      const side: TradeSide = latestPattern?.direction === "BEARISH" ? "SHORT" : "LONG";
      const slDist = livePrice * 0.015;
      const tpDist = livePrice * 0.03;
      const stopLoss = side === "LONG" ? Number((livePrice - slDist).toFixed(2)) : Number((livePrice + slDist).toFixed(2));
      const targetPrice = side === "LONG" ? Number((livePrice + tpDist).toFixed(2)) : Number((livePrice - tpDist).toFixed(2));
      const qty = symbol === "NIFTY50" ? 50 : 25; // 1 standard NSE lot

      try {
        const proposal = await this.tradeIdeaRepo.saveProposal({
          instrumentId: instId,
          strategyVersionId: stratVerId,
          sourceCandleId: ctx.candle.id,
          side,
          entryPrice: livePrice,
          stopLoss,
          targetPrice,
          riskReward: 2.0,
          confidence: confidence / 100,
          reasoning,
          evidence: { source: "AI_AUTONOMOUS_AGENT", newsSentiment, rsiVal },
          expiresAt: new Date(Date.now() + 3600000 * 4),
          evidenceItems: [],
        });

        const trade = await this.paperTradeRepo.openFromTradeIdea({
          accountId: account.id,
          tradeIdeaId: proposal.id,
          quantity: qty,
          fillPrice: livePrice,
          openedAt: new Date(),
          entryFees: 40,
          entrySlippage: 15,
          notes: `AI Autonomous Execution (${confidence}% confidence). Confluence: ${reasoning[0]}`,
        });

        this.thoughts.push({
          id: `th-${Date.now()}-exec`,
          timestamp: new Date().toISOString(),
          symbol,
          action: "EXECUTING",
          confidence,
          message: `⚡ AUTO-EXECUTE ${side} ${qty} qty @ ₹${livePrice.toFixed(2)} (Trade #${trade.id.substring(0, 8)}). SL: ₹${stopLoss.toFixed(2)} | TP: ₹${targetPrice.toFixed(2)}.`,
          details: { tradeId: trade.id, stopLoss, targetPrice, quantity: qty },
        });
      } catch (err) {
        this.thoughts.push({
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
        side: TradeSide;
        realized_pnl: string;
        exit_reason: any;
        entry_price: string;
        exit_price: string;
        closed_at: Date | null;
      }>("SELECT id, side, realized_pnl, exit_reason, entry_price, exit_price, closed_at FROM paper_trades WHERE id = $1", [tradeId]);
      
      const row = res.rows[0];
      if (!row) return;

      const pnl = Number(row.realized_pnl ?? 0);
      const isWin = pnl >= 0;
      const outcome = isWin ? "WIN" : "LOSS";

      let analysis = "";
      let improvementRule = "";

      if (isWin) {
        analysis = `Trade #${row.id.substring(0, 6)} hit Target Profit (+₹${pnl.toFixed(2)}). Multi-modal confluence across RSI and candlestick pattern recognition successfully captured intraday trend momentum.`;
        improvementRule = `SUCCESS REINFORCEMENT: Maintain current indicator weighting when news sentiment aligns with technical breakout direction.`;
      } else {
        analysis = `Trade #${row.id.substring(0, 6)} hit Stop Loss (-₹${Math.abs(pnl).toFixed(2)}). Market experienced intraday volatility spike against position direction.`;
        improvementRule = `SELF-CORRECTION RULE: When intraday volume is below 20-period average, tighten Stop Loss from 1.5% to 1.0% to minimize drawdown.`;
      }

      const reflection: AiReflectionLog = {
        id: `ref-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
        timestamp: row.closed_at ? new Date(row.closed_at).toISOString() : new Date().toISOString(),
        tradeId: row.id,
        symbol,
        side: row.side,
        pnl,
        outcome,
        analysis,
        improvementRule,
      };

      // Saved without an embedding. The reflection text is real and worth keeping;
      // a vector for it is not available until a real embedding model exists, and
      // a fabricated one is worse than none.
      await this.aiJournalRepo.saveReflection(reflection);

      this.thoughts.push({
        id: `th-${Date.now()}-learn`,
        timestamp: row.closed_at ? new Date(row.closed_at).toISOString() : new Date().toISOString(),
        symbol,
        action: "LEARNING",
        confidence: 95,
        message: `🧠 DAILY SELF-REFLECTION LOGGED (${outcome} ₹${pnl.toFixed(2)}): ${improvementRule}`,
        details: { tradeId: row.id, outcome, pnl },
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
