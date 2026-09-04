import "dotenv/config";
import { DUAL_BOT_SANDBOX, type BotSandboxSpec } from "./bot-sandboxes.js";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { classifyOpenFailure } from "../../modules/paper-trading/domain/paper-trade-open-errors.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { PostgresTradeIdeaRepository } from "../../infrastructure/database/repositories/postgres-trade-idea-repository.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { PrepareOptionEntry } from "../../modules/paper-trading/application/prepare-option-entry.js";
import {
  assessDataFreshness,
  barLengthMinutes,
  DEFAULT_MAX_BAR_AGE_MINUTES,
} from "../../modules/paper-trading/domain/bot-data-freshness.js";
import {
  registeredStrategies,
  strategySupportsTimeframe,
} from "../../modules/strategy-engine/domain/strategy-registry.js";
import { calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";
import {
  PostgresRiskStateRepository,
  VOLATILITY_LABEL_SCHEME,
} from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { PostgresRegimeObservationRepository } from "../../infrastructure/database/repositories/postgres-regime-observation-repository.js";
import {
  PostgresCandidateLedgerRepository,
  type CandidateDecisionInput,
} from "../../infrastructure/database/repositories/postgres-candidate-ledger-repository.js";
import { buildRegimeObservation } from "../../modules/strategy-engine/domain/regime-observation.js";
import type { RegimeContext } from "../../modules/strategy-engine/domain/regime.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { defaultRiskPolicy, evaluateRisk } from "../../modules/risk-management/domain/risk.js";
import { isAtOrAfterSessionEntryCutoff } from "../../modules/paper-trading/domain/session-close.js";

/**
 * Refuses to start on a timeframe nothing can trade.
 *
 * The generator skips a strategy whose `supportedTimeframes` do not include the requested
 * one, and reports nothing -- so a misconfigured timeframe looks exactly like a quiet market.
 */
function assertScannableTimeframes(timeframes: readonly string[]): void {
  for (const timeframe of timeframes) {
    const supported = registeredStrategies.some((strategy) => strategySupportsTimeframe(strategy, timeframe));
    if (!supported) {
      throw new Error(
        `No registered strategy supports the ${timeframe} timeframe, so scanning it can only ever `
        + "produce nothing. Supported: "
        + registeredStrategies
          .map((strategy) => `${strategy.registration.strategyKey} (${strategy.supportedTimeframes.join(", ")})`)
          .join("; ") + ".",
      );
    }
  }
}

/**
 * Refuses at startup to scan an instrument that is not active.
 */
async function assertScannableSymbols(
  repository: { findByExchangeAndSymbol(exchange: "NSE", symbol: string): Promise<{ isActive: boolean } | null> },
  symbols: readonly string[],
): Promise<void> {
  for (const symbol of symbols) {
    const instrument = await repository.findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`${symbol} is not a registered instrument, so the bot cannot scan it.`);
    }
    if (!instrument.isActive) {
      throw new Error(
        `${symbol} is registered but is_active = FALSE, which marks it research-only. Scanning it `
        + "would override that flag from the one path that does not check it. Activate the "
        + "instrument deliberately before adding it to SCAN_SYMBOLS.",
      );
    }
  }
}

/** One key per contract, so a persisting signal cannot open the same position twice. */
function contractKey(underlying: string, expiry: Date, strike: number, optionType: string): string {
  return `${underlying} ${expiry.toISOString().slice(0, 10)} ${strike} ${optionType}`;
}



const SCAN_SYMBOLS = ["NIFTY50", "BANKNIFTY"] as const;
/**
 * The scalp band, and only the scalp band.
 *
 * These bots own 1m-15m. 30m, 60m and 1d belong to the autonomous agent's directional, intraday
 * and swing work, so scanning them here would have two systems trading the same bars.
 *
 * `60m` was in this list until 2026-08-17 and could never have worked: `INDICES_INTRADAY` collects
 * 1m, 5m and 15m only, so the newest 60m bar was the 09:15 one for the rest of the session, and
 * the sole 60m-capable strategy is `trend-breakout`, which is not a scalp. `1m` was missing at the
 * same time, which is why `momentum-scalp` -- supported on 1m alone -- could never run at all.
 *
 * `3m` is left out deliberately: both pattern strategies support it, but nothing collects a 3m
 * series, so including it would only add TIMEFRAME_UNSUPPORTED noise against absent bars.
 *
 * `15m` is kept even though no strategy either bot now runs supports it -- all three are 1m/3m/5m,
 * and the only 15m-capable strategy left the sandbox with `trend-breakout`. It stays because 1m-15m
 * is the band these bots are defined to own, so a 15m-capable scalp strategy should become
 * tradeable by adding it to a bot rather than by also remembering to widen this list. The cost is
 * a TIMEFRAME_UNSUPPORTED line per strategy per symbol per run, which is noise in the report and
 * nothing more. Drop it if that noise ever obscures something real.
 */
const SCAN_TIMEFRAMES = ["1m", "5m", "15m"] as const;
const MAX_CONCURRENT_POSITIONS = defaultRiskPolicy.maxConcurrentPositions;
const MARKET_OPEN_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;
/** An intraday signal raised after this has no session left to resolve in. */
const LAST_SIGNAL_MINUTES = 15 * 60 + 25;

/**
 * Records the regime observed for one series, returning its id, or null if it could not be recorded.
 *
 * Both readings are already in hand at this point and both were being discarded: the volatility
 * regime is derived per bar by the context repository, and the model regime is read by the risk
 * gate. Neither survived the run, so answering "did trades opened in HIGH_VOL fare worse?" later
 * meant re-deriving from `candles`, `indicator_snapshots`, and whichever model is in PRODUCTION
 * *then* -- three moving inputs, so the answer would drift without anything being wrong.
 *
 * Failure is swallowed on purpose. This record is research, not a control: a trade that cannot have
 * its regime recorded must still open, unstamped. Throwing here would let a research table decide
 * whether the bot trades, which is the one thing this must never do. The error is logged so a
 * persistent failure is visible rather than silent.
 */
async function recordRegimeObservation(input: {
  regimeRepository: PostgresRegimeObservationRepository;
  riskRepository: PostgresRiskStateRepository;
  instrumentId: string;
  timeframe: string;
  sourceCandleId: string | null;
  volatility: RegimeContext | null;
  now: Date;
}): Promise<string | null> {
  try {
    const model = await input.riskRepository.findVolatilityRegime({
      instrumentId: input.instrumentId,
      asOf: input.now,
      // Matches the window the risk gate itself uses, so the recorded reading is the one the
      // decision could see rather than a more generous lookback taken for the record's benefit.
      maxAgeMinutes: 60,
    });
    const stored = await input.regimeRepository.record(buildRegimeObservation({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      sourceCandleId: input.sourceCandleId,
      observedAt: input.now,
      volatility: input.volatility,
      model,
      modelLabelScheme: VOLATILITY_LABEL_SCHEME,
    }));
    return stored.id;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Could not record the regime observation; trades will open unstamped.",
      timeframe: input.timeframe,
      reason: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

function istMinutesSinceMidnight(now: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", hour12: false,
  }).format(now);
  const [hour, minute] = formatted.split(":").map(Number);
  return hour * 60 + minute;
}

async function main(): Promise<void> {
  assertScannableTimeframes(SCAN_TIMEFRAMES);
  const now = new Date();
  const minutes = istMinutesSinceMidnight(now);
  if (minutes < MARKET_OPEN_MINUTES || minutes > MARKET_CLOSE_MINUTES) {
    console.info(JSON.stringify({ level: "info", message: "Market closed; bot skipped." }));
    return;
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const { isNseHoliday } = await import("../../modules/market-data/domain/nse-session-calendar.js");
    const holiday = await isNseHoliday(database, now);
    if (holiday.holiday) {
      console.info(JSON.stringify({
        level: "info",
        message: "NSE holiday; bot skipped.",
        holiday: holiday.name,
      }));
      return;
    }

    const accountRepository = new PostgresPaperAccountRepository(database);
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const tradeRepository = new PostgresPaperTradeRepository(database);

    await assertScannableSymbols(instrumentRepository, SCAN_SYMBOLS);

    const prepareEntry = new PrepareOptionEntry(
      database,
      new PostgresOptionChainRepository(database),
      new PostgresOptionPremiumTickRepository(database),
    );
    const openTrade = new OpenPaperTrade(tradeRepository);
    const riskRepository = new PostgresRiskStateRepository(database);
    const regimeRepository = new PostgresRegimeObservationRepository(database);
    const ledger = new PostgresCandidateLedgerRepository(database);

    const generator = new GenerateTradeIdeas(
      new PostgresStrategyVersionRepository(database),
      new PostgresStrategyMarketContextRepository(database),
      new PostgresTradeIdeaRepository(database),
    );

    // Collect fresh trade ideas per symbol and timeframe once per run
    const generatedBySeries: Array<{
      symbol: string;
      timeframe: string;
      results: Awaited<ReturnType<typeof generator.execute>>;
      /**
       * Recorded once per series, so both bots stamp the same observation. The regime is a property
       * of the bar, not of the account that acted on it -- writing one row per bot would make a
       * later `GROUP BY regime` double-count every bar both bots traded.
       */
      regimeObservationId: string | null;
      skippedReason?: string;
      explanation?: string;
    }> = [];

    const skippedSeries: Array<Record<string, unknown>> = [];

    if (minutes < LAST_SIGNAL_MINUTES) {
      for (const symbol of SCAN_SYMBOLS) {
        const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
        if (!instrument) continue;

        for (const timeframe of SCAN_TIMEFRAMES) {
          const latest = await database.query<{ close_time: Date }>(
            `SELECT close_time FROM candles
             WHERE instrument_id = $1 AND timeframe = $2 AND is_complete = TRUE
             ORDER BY close_time DESC LIMIT 1`,
            [instrument.id, timeframe],
          );
          const freshness = assessDataFreshness({
            symbol: `${symbol} ${timeframe}`,
            latestBarCloseTime: latest.rows[0]?.close_time ?? null,
            now,
            maxAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES + barLengthMinutes(timeframe),
          });
          if (!freshness.fresh) {
            skippedSeries.push({ symbol, timeframe, reason: freshness.reason, explanation: freshness.explanation });
            console.error(JSON.stringify({
              level: "error", message: "Skipped a series on stale data", symbol, timeframe,
              reason: freshness.reason, explanation: freshness.explanation,
            }));
            continue;
          }

          const results = await generator.execute({ instrumentId: instrument.id, timeframe });
          // Every strategy evaluated the same bar, so any result carries the same reading. The
          // first with a candle id is the bar that was actually evaluated.
          const evaluated = results.find((result) => result.sourceCandleId !== null);
          const regimeObservationId = await recordRegimeObservation({
            regimeRepository,
            riskRepository,
            instrumentId: instrument.id,
            timeframe,
            sourceCandleId: evaluated?.sourceCandleId ?? null,
            volatility: evaluated?.regime ?? null,
            now,
          });
          generatedBySeries.push({ symbol, timeframe, results, regimeObservationId });
        }
      }
    }

    const botReports: Array<Record<string, unknown>> = [];
    /**
     * Faults, as opposed to refusals. Collected across every bot and acted on only after the whole
     * cycle has run, so a genuine problem still marks the job FAILED without costing the
     * open-position evaluation that used to be skipped when a failure aborted mid-run.
     */
    const unexpectedOpenFailures: Array<Record<string, unknown>> = [];

    // Execute isolated trading logic for each bot sandbox in DUAL_BOT_SANDBOX
    for (const botSpec of DUAL_BOT_SANDBOX) {
      let account = await accountRepository.findByName(botSpec.name);
      if (!account) {
        account = await accountRepository.create({ name: botSpec.name, openingBalance: botSpec.initialBalance });
        console.info(JSON.stringify({ level: "info", message: "Created bot account", account: botSpec.name }));
      }

      const opened: Array<Record<string, unknown>> = [];
      const strategyOutcomes: Array<Record<string, unknown>> = [];
      const refused: Array<Record<string, unknown>> = [];

      const existingOpen = await tradeRepository.listOpenByAccount(account.id);
      const heldContracts = new Set(
        existingOpen
          .filter((trade) => trade.optionStrike != null && trade.optionExpiry != null)
          .map((trade) => contractKey(
            String(trade.underlyingSymbol ?? ""),
            trade.optionExpiry as Date,
            Number(trade.optionStrike),
            String(trade.optionType ?? ""),
          )),
      );
      let openPositions = existingOpen.length;

      for (const { symbol, timeframe, results, regimeObservationId } of generatedBySeries) {
        const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
        if (!instrument) continue;

        // Filter results to only strategies permitted for this specific bot
        const botResults = results.filter((res) => botSpec.allowedStrategies.includes(res.strategyKey));

        for (const result of botResults) {
          if (result.skippedReason) {
            strategyOutcomes.push({
              symbol, timeframe, strategy: result.strategyKey,
              skippedReason: result.skippedReason,
              ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
            });
            continue;
          }

          strategyOutcomes.push({
            symbol, timeframe, strategy: result.strategyKey,
            skippedReason: null,
            candidatesGenerated: result.candidatesGenerated,
            ideasRaised: result.tradeIdeaIds.length,
          });

          for (const tradeIdeaId of result.tradeIdeaIds) {
            // Ahead of every other check, including the provider call in `prepareEntry`: a
            // position opened now is one the exit sweep is obliged to square off, so the only
            // thing the entry could still buy is a round trip of brokerage.
            if (isAtOrAfterSessionEntryCutoff(now)) {
              refused.push({
                tradeIdeaId, symbol, timeframe,
                reason: "SESSION_ENTRY_CUTOFF",
                explanation: "New entries are closed for the session: the square-off cutoff has passed.",
              });
              continue;
            }

            if (openPositions >= MAX_CONCURRENT_POSITIONS) {
              refused.push({
                tradeIdeaId, symbol, reason: "POSITION_LIMIT",
                explanation: `Already holding ${openPositions} positions, the limit is ${MAX_CONCURRENT_POSITIONS}.`,
              });
              continue;
            }

            const prepared = await prepareEntry.execute({ tradeIdeaId, lots: 1, now });
            if (!prepared.approved) {
              refused.push({
                tradeIdeaId, symbol, timeframe,
                reason: prepared.reason,
                explanation: prepared.explanation,
                ...(prepared.reasons ? { reasons: prepared.reasons } : {}),
                ...(prepared.unchecked ? { unchecked: prepared.unchecked } : {}),
              });
              continue;
            }

            const entry = prepared.entry;
            const riskState = await riskRepository.findRiskState({
              accountId: account.id,
              instrumentId: instrument.id,
              asOf: now,
              maxRegimeAgeMinutes: 60,
            });
            const riskDecision = evaluateRisk({
              instrumentId: instrument.id,
              decisionTimestamp: now,
              side: entry.side,
              entryPrice: entry.fillPrice,
              stopLoss: entry.stopLossOverride,
              targetPrice: entry.targetPriceOverride,
              lotSize: entry.lotSize,
            }, riskState);

            if (!riskDecision.approved) {
              refused.push({
                tradeIdeaId, symbol, timeframe,
                reason: "RISK_CONTROL_VETO",
                explanation: `Risk engine refused the entry: ${riskDecision.reasonCodes.join(", ")}.`,
              });
              continue;
            }

            const approvedQuantity = Math.min(entry.quantity, riskDecision.approvedQuantity);
            const key = contractKey(
              entry.optionContract.underlyingSymbol,
              entry.optionContract.optionExpiry,
              entry.optionContract.optionStrike,
              entry.optionContract.optionType,
            );
            if (heldContracts.has(key)) {
              refused.push({
                tradeIdeaId, symbol, reason: "ALREADY_HOLDING",
                explanation: `A position in ${key} is already open; a persisting signal must not become a new position on every scan.`,
              });
              continue;
            }

            const riskNote = ` Risk checks: ${riskDecision.reasonCodes.join(", ")}.`;

            let trade;
            try {
              trade = await openTrade.execute({
                accountId: account.id,
                tradeIdeaId,
                fillPrice: entry.fillPrice,
                quantity: approvedQuantity,
                openedAt: now,
                entryFees: entry.entryFees,
                entrySlippage: 0,
                notes: `Opened by ${botSpec.name} from a ${timeframe} ${symbol} signal.${riskNote}`,
                orderType: "MARKET",
                stopLossOverride: entry.stopLossOverride,
                targetPriceOverride: entry.targetPriceOverride,
                sideOverride: entry.side,
                feeBreakdown: entry.feeBreakdown,
                applyBrokerageFees: false,
                optionContract: entry.optionContract,
                regimeObservationId,
              });
            } catch (error) {
              // Scoped to this one idea. The next idea, the next bot, and every account's
              // open-position evaluation all still run -- that last one is what an aborted run used
              // to cost, and it matters more than the trade that was missed.
              const failure = classifyOpenFailure(error);
              refused.push({
                tradeIdeaId, symbol, timeframe,
                reason: failure.reason,
                explanation: failure.explanation,
              });
              if (!failure.expected) {
                unexpectedOpenFailures.push({
                  bot: botSpec.name, tradeIdeaId, symbol, timeframe, explanation: failure.explanation,
                });
                console.error(JSON.stringify({
                  level: "error",
                  message: "Opening a paper trade failed for a reason this bot does not expect.",
                  bot: botSpec.name, tradeIdeaId, symbol, timeframe,
                  explanation: failure.explanation,
                }));
              }
              continue;
            }

            heldContracts.add(key);
            openPositions += 1;
            opened.push({
              paperTradeId: trade.id,
              tradeIdeaId,
              symbol,
              timeframe,
              contract: key,
              fillPremium: entry.fillPrice,
              stopPremium: entry.stopLossOverride,
              targetPremium: entry.targetPriceOverride,
              quantity: approvedQuantity,
              lotSize: entry.lotSize,
              entryFees: entry.entryFees,
              estimatedExitFees: Number(calculateExitFees(entry.fillPrice, approvedQuantity).total.toFixed(2)),
              fillSource: (entry.feeBreakdown.entryChecks as { fillSource?: string } | undefined)?.fillSource,
              unchecked: entry.unchecked,
              regimeObservationId,
            });
          }
        }
      }

      // Evaluate open positions for this bot account
      const evaluation = await new EvaluateOpenPaperTrades(
        tradeRepository,
        new PostgresCandleRepository(database),
        new PostgresIndiaVixImpliedVolatilitySource(database),
        new PostgresOptionPremiumTickRepository(database),
      ).execute({ accountId: account.id, asOf: now });

      /*
       * Persist this account's decisions, derived from the arrays the run already built.
       *
       * Done here rather than at each of the six decision sites, so a refusal added later is recorded
       * without anyone remembering to. Until now every reason -- NO_FRESH_EXECUTABLE_QUOTE,
       * OPTIONS_ENTRY_REJECTED, ALREADY_HOLDING, POSITION_LIMIT, RISK_CONTROL_VETO -- lived only in
       * this container's log, which rotates. That is the "why did we pass on it" data, and it was
       * being destroyed daily.
       *
       * Failure is swallowed per row on purpose: this is a research ledger, and losing a decision
       * record must not fail a trading cycle. It is logged so a persistent failure is visible.
       */
      const decisionsToRecord: CandidateDecisionInput[] = [
        ...opened.map((entry) => ({
          tradeIdeaId: String(entry.tradeIdeaId),
          accountId: account.id,
          decidedAt: now,
          decision: "EXECUTED" as const,
          reason: "OPENED",
          explanation: `Opened ${String(entry.contract ?? "")} at ${String(entry.fillPremium ?? "")}.`,
          paperTradeId: String(entry.paperTradeId),
          regimeObservationId: (entry.regimeObservationId as string | null) ?? null,
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
            bot: botSpec.name,
            tradeIdeaId: decision.tradeIdeaId,
            reason: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      botReports.push({
        botName: botSpec.name,
        accountId: account.id,
        decisionsRecorded,
        allowedStrategies: botSpec.allowedStrategies,
        positionsOpened: opened.length,
        signalsRefused: refused.length,
        openPositionsAfterRun: openPositions,
        tradesEvaluated: evaluation.openTradesRead + evaluation.pendingTradesRead,
        tradesClosed: evaluation.tradesClosed,
        evaluationFailures: evaluation.evaluationFailures,
        opened,
        strategyOutcomes,
        refused,
      });
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Paper trading dual-bot run complete",
      timestamp: now.toISOString(),
      skippedSeries,
      unexpectedOpenFailures,
      bots: botReports,
    }, null, 2));

    // Raised at the end rather than where it happened, so the cycle finishes its work first. A
    // contended or capped idea is not in here; those are refusals and the run stays healthy.
    if (unexpectedOpenFailures.length > 0) {
      throw new Error(
        `${unexpectedOpenFailures.length} paper trade open(s) failed unexpectedly. `
        + "Every other bot and the open-position evaluation still ran; see unexpectedOpenFailures.",
      );
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Paper trading bot failed:", error);
  process.exitCode = 1;
});
