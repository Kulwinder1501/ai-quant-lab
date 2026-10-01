import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { PostgresTradeIdeaRepository } from "../../infrastructure/database/repositories/postgres-trade-idea-repository.js";
import { PostgresCandidateLedgerRepository, type CandidateDecisionInput } from "../../infrastructure/database/repositories/postgres-candidate-ledger-repository.js";
import { TwelveDataQuoteClient } from "../../infrastructure/market-data/twelvedata-quote-client.js";
import { classifyOpenFailure } from "../../modules/paper-trading/domain/paper-trade-open-errors.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { MAXIMUM_EXECUTABLE_QUOTE_AGE_MS, PrepareDirectEntry } from "../../modules/paper-trading/application/prepare-direct-entry.js";
import {
  assessDataFreshness,
  barLengthMinutes,
  DEFAULT_MAX_BAR_AGE_MINUTES,
} from "../../modules/paper-trading/domain/bot-data-freshness.js";
import { isNearXauWeeklyClose, isXauSessionOpen } from "../../modules/platform/calendar/continuous-weekly-session.js";
import { istMinuteOfDay } from "../../modules/platform/calendar/trading-session.js";
import { buildAndEvaluateDxyIntermarket } from "../../modules/strategy-engine/application/dxy-intermarket-helper.js";

/**
 * A single, standalone paper-trading bot for XAU_USD -- deliberately not folded into
 * `run-paper-trading-bot.ts`'s `DUAL_BOT_SANDBOX` loop. That loop is built around Indian
 * index options end to end: `PrepareOptionEntry` resolves a strike/expiry against an option
 * chain, positions are tracked by `contractKey` (strike/expiry/type), and the whole run is
 * gated by one NSE 9:15-15:30 IST window plus an NSE holiday check. None of that exists for
 * XAU_USD (no option chain, no strikes, a continuous near-24/5 session), and reusing the loop
 * would mean threading an instrument-specific branch through every one of those assumptions.
 * A separate script mirrors the shape instead: its own session gate, its own direct-fill entry
 * path (`PrepareDirectEntry`), its own account, and its own bot process.
 *
 * Explicit v1 simplifications, not oversights:
 * - No `evaluateRisk`/`defaultRiskPolicy` gate: that risk engine's calibration (lot sizing,
 *   regime lookups) has only ever been exercised against INR index options and has not been
 *   checked for a USD direct-fill instrument. `MAX_CONCURRENT_POSITIONS` below is the safety
 *   valve for this bot instead.
 * - No consecutive-loss cooldown (the NSE bots' `assessMomentumScalpLossGuard`): can be added
 *   once this bot has its own trade history to guard against.
 */

const XAU_EXCHANGE = "TWELVEDATA" as const;
const XAU_SYMBOL = "XAU_USD";
const SCAN_TIMEFRAMES = ["5m", "15m"] as const;
const GOLD_STRATEGY_KEY = "ict-structure-v1";
const MAX_CONCURRENT_POSITIONS = 1;
const GOLD_ACCOUNT_NAME = "AutoBot-Gold";
/** Arbitrary, illustrative paper balance -- not derived from any real account. */
const GOLD_INITIAL_BALANCE_USD = 100_000;
/** A signal this close to the weekly close has no session left to manage before the weekend gap. */
const WEEKLY_ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE = 30;

/**
 * Kill switch, same shape as `ORDERBOOK01_LIVE_GATE_ENABLED`
 * (options-entry-validator.ts): `ict-structure-v1`'s only real evidence is being
 * TERMINAL_UNOWNED for sign-instability on NIFTY50/BANKNIFTY, and it was re-enabled here
 * (2026-09-30, alongside `XAU_BOT_ENABLED`) for XAU_USD specifically with zero validation on
 * that instrument. Trade-idea generation and the ICT reasoning below run unconditionally --
 * this only gates the last step, actually opening a real (paper) position -- so the bot still
 * scans, still logs what it would have done, and every signal is still recorded on the
 * candidate ledger as a decision, just as REFUSED rather than EXECUTED while this is off.
 * Defaults OFF; set to exactly "true" to let the bot open positions on gold.
 */
const GOLD_ICT_LIVE_ENTRIES_ENABLED = process.env.GOLD_ICT_LIVE_ENTRIES_ENABLED === "true";

function isUserOperatingWindow(now: Date): boolean {
  const minute = istMinuteOfDay(now);
  return minute >= 9 * 60 && minute < 21 * 60; // 09:00 AM - 09:00 PM IST
}

async function assertScannableSymbol(
  repository: { findByExchangeAndSymbol(exchange: typeof XAU_EXCHANGE, symbol: string): Promise<{ isActive: boolean } | null> },
): Promise<void> {
  const instrument = await repository.findByExchangeAndSymbol(XAU_EXCHANGE, XAU_SYMBOL);
  if (!instrument) {
    throw new Error(`${XAU_SYMBOL} is not a registered ${XAU_EXCHANGE} instrument, so the bot cannot scan it.`);
  }
  if (!instrument.isActive) {
    throw new Error(`${XAU_SYMBOL} is registered but is_active = FALSE; activate it before scanning.`);
  }
}

async function main(): Promise<void> {
  const now = new Date();
  if (!isXauSessionOpen(now)) {
    console.info(JSON.stringify({ level: "info", message: "XAU_USD session closed; gold bot skipped." }));
    return;
  }
  if (!isUserOperatingWindow(now)) {
    console.info(JSON.stringify({ level: "info", message: "Outside operating window (09:00 - 21:00 IST); gold bot skipped." }));
    return;
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const twelveDataApiKey = process.env.TWELVEDATA_API_KEY;
  if (!twelveDataApiKey) {
    console.error(JSON.stringify({
      level: "error",
      message: "TWELVEDATA_API_KEY is not configured; the gold bot cannot fetch a live quote and was skipped.",
    }));
    await database.end();
    return;
  }

  try {
    const accountRepository = new PostgresPaperAccountRepository(database);
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const tradeRepository = new PostgresPaperTradeRepository(database);

    await assertScannableSymbol(instrumentRepository);
    const instrument = await instrumentRepository.findByExchangeAndSymbol(XAU_EXCHANGE, XAU_SYMBOL);
    if (!instrument) return; // assertScannableSymbol already refused this; narrows the type below.

    let account = await accountRepository.findByName(GOLD_ACCOUNT_NAME);
    if (!account) {
      account = await accountRepository.create({
        name: GOLD_ACCOUNT_NAME,
        openingBalance: GOLD_INITIAL_BALANCE_USD,
        currency: "USD",
      });
      console.info(JSON.stringify({ level: "info", message: "Created bot account", account: GOLD_ACCOUNT_NAME }));
    }

    const quoteClient = new TwelveDataQuoteClient({ apiKey: twelveDataApiKey });
    const prepareEntry = new PrepareDirectEntry(database, quoteClient);
    const openTrade = new OpenPaperTrade(tradeRepository);
    const ledger = new PostgresCandidateLedgerRepository(database);
    const generator = new GenerateTradeIdeas(
      new PostgresStrategyVersionRepository(database),
      new PostgresStrategyMarketContextRepository(database),
      new PostgresTradeIdeaRepository(database),
    );

    const opened: Array<Record<string, unknown>> = [];
    const strategyOutcomes: Array<Record<string, unknown>> = [];
    const refused: Array<Record<string, unknown>> = [];
    const skippedSeries: Array<Record<string, unknown>> = [];

const GOLD_LEVERAGE = 20;
const GOLD_RISK_PER_TRADE_PERCENT = 1.0;

    const existingOpen = await tradeRepository.listOpenByAccount(account.id);
    let openPositions = existingOpen.length;

    const closedPnlResult = await database.query<{ total_pnl: string }>(
      `SELECT COALESCE(SUM(realized_pnl), 0) AS total_pnl FROM paper_trades WHERE account_id = $1 AND status = 'CLOSED'`,
      [account.id],
    );
    const realizedPnl = Number(closedPnlResult.rows[0]?.total_pnl ?? 0);
    const accountEquity = account.openingBalance + realizedPnl;
    const lockedMargin = existingOpen.reduce(
      (sum, trade) => sum + (trade.entryPrice * trade.quantity) / GOLD_LEVERAGE,
      0,
    );
    const availableMargin = Math.max(0, accountEquity - lockedMargin);

    if (!isNearXauWeeklyClose(now, WEEKLY_ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE)) {
      for (const timeframe of SCAN_TIMEFRAMES) {
        const latest = await database.query<{ close_time: Date }>(
          `SELECT close_time FROM candles
           WHERE instrument_id = $1 AND timeframe = $2 AND is_complete = TRUE
           ORDER BY close_time DESC LIMIT 1`,
          [instrument.id, timeframe],
        );
        const freshness = assessDataFreshness({
          symbol: `${XAU_SYMBOL} ${timeframe}`,
          latestBarCloseTime: latest.rows[0]?.close_time ?? null,
          now,
          maxAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES + barLengthMinutes(timeframe),
        });
        if (!freshness.fresh) {
          skippedSeries.push({ timeframe, reason: freshness.reason, explanation: freshness.explanation });
          console.error(JSON.stringify({
            level: "error", message: "Skipped a series on stale data", symbol: XAU_SYMBOL, timeframe,
            reason: freshness.reason, explanation: freshness.explanation,
          }));
          continue;
        }

        const results = await generator.execute({ instrumentId: instrument.id, timeframe });
        const goldResults = results.filter((result) => result.strategyKey === GOLD_STRATEGY_KEY);

        for (const result of goldResults) {
          if (result.skippedReason) {
            strategyOutcomes.push({
              timeframe, strategy: result.strategyKey, skippedReason: result.skippedReason,
              ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
            });
            continue;
          }
          strategyOutcomes.push({
            timeframe, strategy: result.strategyKey, skippedReason: null,
            candidatesGenerated: result.candidatesGenerated, ideasRaised: result.tradeIdeaIds.length,
          });

          for (const tradeIdeaId of result.tradeIdeaIds) {
            // Evaluate DXY_INTERMARKET_V1 observational metadata in SHADOW mode
            try {
              const dxyPayload = await buildAndEvaluateDxyIntermarket(database, {
                proposalSide: "LONG", // Default or fetch idea side
                proposalTimeframe: timeframe,
                candidateAt: now.toISOString(),
                dataCutoff: now.toISOString(),
                decisionAt: now.toISOString(),
              });
              console.info(JSON.stringify({
                level: "info",
                message: "DXY_INTERMARKET_V1 Shadow Observation",
                tradeIdeaId,
                timeframe,
                dxyPayload,
              }));
            } catch (err) {
              console.error(JSON.stringify({
                level: "error",
                message: "Failed evaluating DXY_INTERMARKET_V1 shadow observation",
                tradeIdeaId,
                error: String(err),
              }));
            }

            if (openPositions >= MAX_CONCURRENT_POSITIONS) {
              refused.push({
                tradeIdeaId, timeframe, reason: "POSITION_LIMIT",
                explanation: `Already holding ${openPositions} position(s), the limit is ${MAX_CONCURRENT_POSITIONS}.`,
              });
              continue;
            }

            const prepared = await prepareEntry.execute({
              tradeIdeaId,
              now,
              leverage: GOLD_LEVERAGE,
              accountEquity,
              availableMargin,
              riskPercent: GOLD_RISK_PER_TRADE_PERCENT,
              dynamicSizing: true,
            });
            if (!prepared.approved) {
              refused.push({ tradeIdeaId, timeframe, reason: prepared.reason, explanation: prepared.explanation });
              continue;
            }

            const entry = prepared.entry;

            if (!GOLD_ICT_LIVE_ENTRIES_ENABLED) {
              // Shadow mode: the signal cleared every gate up to and including sizing, but
              // GOLD_ICT_LIVE_ENTRIES_ENABLED is off, so no real (paper) position is opened for
              // an as-yet-unvalidated instrument. Still recorded on the candidate ledger --
              // as REFUSED, the closest fit the ledger's decision type offers -- so the "would
              // have opened" signal isn't lost, and still fully logged below.
              refused.push({
                tradeIdeaId, timeframe, reason: "GOLD_ICT_LIVE_ENTRIES_DISABLED",
                explanation: `Would have opened at ${entry.fillPrice} (qty ${entry.quantity}, ${entry.leverage ?? 20}x); GOLD_ICT_LIVE_ENTRIES_ENABLED is not "true".`,
              });
              continue;
            }

            let trade;
            try {
              trade = await openTrade.execute({
                accountId: account.id,
                tradeIdeaId,
                fillPrice: entry.fillPrice,
                quantity: entry.quantity,
                openedAt: now,
                entryFees: entry.entryFees,
                entrySlippage: 0,
                notes: `Opened by ${GOLD_ACCOUNT_NAME} from a ${timeframe} ${XAU_SYMBOL} signal. Required margin: $${entry.requiredMargin?.toFixed(2) ?? "N/A"} (${entry.leverage ?? 20}x leverage).`,
                orderType: "MARKET",
                stopLossOverride: entry.stopLossOverride,
                targetPriceOverride: entry.targetPriceOverride,
                sideOverride: entry.side,
                feeBreakdown: entry.feeBreakdown,
                applyBrokerageFees: false,
                // No optionContract: this is a bare direct-fill position, not an option buyer.
              });
            } catch (error) {
              const failure = classifyOpenFailure(error);
              refused.push({ tradeIdeaId, timeframe, reason: failure.reason, explanation: failure.explanation });
              if (!failure.expected) {
                console.error(JSON.stringify({
                  level: "error", message: "Opening the gold paper trade failed unexpectedly.",
                  tradeIdeaId, timeframe, explanation: failure.explanation,
                }));
              }
              continue;
            }

            openPositions += 1;
            opened.push({
              paperTradeId: trade.id, tradeIdeaId, timeframe,
              fillPrice: entry.fillPrice, stopLoss: entry.stopLossOverride, targetPrice: entry.targetPriceOverride,
              quantity: entry.quantity, requiredMargin: entry.requiredMargin, leverage: entry.leverage,
            });
          }
        }
      }
    }

    // Live spot for stop/target evaluation, same freshness discipline as the entry path: a
    // stale or missing quote falls back to the completed-candle evaluator inside
    // EvaluateOpenPaperTrades rather than being treated as a price. `quoteSymbol` can return a
    // quote it only ever served from cache (TwelveDataQuoteClient's "stale beats blank" fallback
    // during an outage or a 429), so price truthiness alone is not enough -- its age has to be
    // checked the same way `PrepareDirectEntry` checks it before filling an entry.
    const quote = await quoteClient.quoteSymbol(XAU_SYMBOL).catch(() => null);
    const quoteAgeMs = quote?.regularMarketTime ? now.getTime() - quote.regularMarketTime.getTime() : null;
    const freshQuotePrice = quote?.regularMarketPrice && quote.regularMarketPrice > 0
      && quoteAgeMs !== null && quoteAgeMs >= 0 && quoteAgeMs <= MAXIMUM_EXECUTABLE_QUOTE_AGE_MS
      ? quote.regularMarketPrice
      : null;
    const livePrices = freshQuotePrice !== null ? { [XAU_SYMBOL]: freshQuotePrice } : undefined;

    const evaluation = await new EvaluateOpenPaperTrades(
      tradeRepository,
      new PostgresCandleRepository(database),
    ).execute({
      accountId: account.id,
      asOf: now,
      // No cost schedule exists for this instrument; see PrepareDirectEntry.
      exitFees: 0,
      livePrices,
    });

    const decisionsToRecord: CandidateDecisionInput[] = [
      ...opened.map((entry) => ({
        tradeIdeaId: String(entry.tradeIdeaId),
        accountId: account.id,
        decidedAt: now,
        decision: "EXECUTED" as const,
        reason: "OPENED",
        explanation: `Opened at ${String(entry.fillPrice ?? "")}.`,
        paperTradeId: String(entry.paperTradeId),
        regimeObservationId: null,
      })),
      ...refused.map((entry) => ({
        tradeIdeaId: String(entry.tradeIdeaId),
        accountId: account.id,
        decidedAt: now,
        decision: "REFUSED" as const,
        reason: String(entry.reason),
        explanation: String(entry.explanation ?? ""),
        regimeObservationId: null,
      })),
    ];
    let decisionsRecorded = 0;
    for (const decision of decisionsToRecord) {
      try {
        await ledger.recordDecision(decision);
        decisionsRecorded += 1;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "Could not record a candidate decision; the trade is unaffected.",
          tradeIdeaId: decision.tradeIdeaId,
          reason: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Gold paper trading bot run complete",
      timestamp: now.toISOString(),
      accountId: account.id,
      goldIctLiveEntriesEnabled: GOLD_ICT_LIVE_ENTRIES_ENABLED,
      decisionsRecorded,
      skippedSeries,
      strategyOutcomes,
      positionsOpened: opened.length,
      signalsRefused: refused.length,
      openPositionsAfterRun: openPositions,
      tradesEvaluated: evaluation.openTradesRead + evaluation.pendingTradesRead,
      tradesClosed: evaluation.tradesClosed,
      evaluationFailures: evaluation.evaluationFailures,
      opened,
      refused,
    }, null, 2));

    if (evaluation.evaluationFailures.length > 0) {
      throw new Error(
        `${evaluation.evaluationFailures.length} open gold trade(s) failed to evaluate; see evaluationFailures.`,
      );
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Gold paper trading bot failed:", error);
  process.exitCode = 1;
});
