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
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { PrepareOptionEntry } from "../../modules/paper-trading/application/prepare-option-entry.js";
import { assessDataFreshness, DEFAULT_MAX_BAR_AGE_MINUTES } from "../../modules/paper-trading/domain/bot-data-freshness.js";
import {
  registeredStrategies,
  strategySupportsTimeframe,
} from "../../modules/strategy-engine/domain/strategy-registry.js";
import { calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";
import { PostgresRiskStateRepository } from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { defaultRiskPolicy, evaluateRisk } from "../../modules/risk-management/domain/risk.js";

/** Minutes in one bar of a timeframe, so a series is not called stale for lagging by design. */
function barLengthMinutes(timeframe: string): number {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) return 0;
  const size = Number(match[1]);
  return match[2] === "m" ? size : match[2] === "h" ? size * 60 : size * 60 * 24;
}

/**
 * Refuses to start on a timeframe nothing can trade.
 *
 * The generator skips a strategy whose `supportedTimeframes` do not include the requested
 * one, and reports nothing -- so a misconfigured timeframe looks exactly like a quiet market.
 * That is how this bot spent its time scanning 5m, which no strategy has ever supported.
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

/** One key per contract, so a persisting signal cannot open the same position twice. */
function contractKey(underlying: string, expiry: Date, strike: number, optionType: string): string {
  return `${underlying} ${expiry.toISOString().slice(0, 10)} ${strike} ${optionType}`;
}

/**
 * Opens **paper** option positions from generated signals, and evaluates the open ones.
 *
 * Nothing here reaches a broker. Every position is a row in `paper_trades`, priced against
 * the observed book; there is no order path and none should be added here.
 *
 * It previously opened a position in NIFTY50 or BANKNIFTY at the *index close*, which is not
 * a purchasable instrument, sized at `quantity: 1` against lots of 75 and 15, and passed
 * `entryFees: 0`. Every P&L it produced was wrong in three independent ways and none of them
 * surfaced as an error, so it was made signal-only until the options path could carry it.
 *
 * It now routes through `PrepareOptionEntry` -- the same code the HTTP route uses, not a
 * second copy of it. That is the whole point of the shared service: the gates it enforces
 * (the expiry must be one the provider lists, the entry premium must be the book's ask, the
 * pre-trade checklist must actually run) are each invisible when missing, and this caller
 * runs unattended every five minutes.
 *
 * Two limits are the bot's own, because an interactive caller does not need them: it will
 * not hold more than `MAX_CONCURRENT_POSITIONS`, and it will not open a second position in a
 * contract it already holds. Without those, a signal that persists across scans becomes a
 * new position every five minutes.
 */

const BOT_ACCOUNT_NAME = "AutoBot";
const SCAN_SYMBOLS = ["NIFTY50", "BANKNIFTY"] as const;
/**
 * `5m` used to be here, and **no registered strategy supports it** -- trend-breakout takes
 * 15m/30m/60m/1d and momentum-scalp takes 1m. Every scan was a silent no-op: the generator
 * skipped both strategies and returned nothing, which is indistinguishable in the output from
 * a market with no setups. `assertScannableTimeframes` below turns that into a startup error.
 *
 * 1m is deliberately not scanned. It is the only fresh intraday series -- the live poller
 * writes it -- but its only strategy is momentum-scalp, which needs VWAP, and VWAP needs
 * volume. The Fyers quotes endpoint returns `volume: 0` for an index, so those bars carry
 * none: measured 2026-08-07, NIFTY50 1m has 375 VWAP snapshots on 05 Aug's history bars and
 * **0** on today's live ones. Scanning it would produce nothing, slowly.
 */
const SCAN_TIMEFRAMES = ["15m"] as const;
/**
 * Deliberately small. The account is Rs 1,000,000 and one NIFTY lot of a 200-point premium
 * is Rs 15,000, so this is not a capital limit -- it is a blast radius. The bot's edge is
 * unproven, and its own trade history is the evidence that will decide whether it has one.
 */
const MAX_CONCURRENT_POSITIONS = defaultRiskPolicy.maxConcurrentPositions;
const MARKET_OPEN_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;
/** An intraday signal raised after this has no session left to resolve in. */
const LAST_SIGNAL_MINUTES = 15 * 60 + 25;

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
    const accountRepository = new PostgresPaperAccountRepository(database);
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const tradeRepository = new PostgresPaperTradeRepository(database);

    let account = await accountRepository.findByName(BOT_ACCOUNT_NAME);
    if (!account) {
      account = await accountRepository.create({ name: BOT_ACCOUNT_NAME, openingBalance: 1_000_000 });
      console.info(JSON.stringify({ level: "info", message: "Created bot account", account: BOT_ACCOUNT_NAME }));
    }

    const opened: Array<Record<string, unknown>> = [];
    /** What each strategy actually did, so an empty run is never ambiguous. */
    const strategyOutcomes: Array<Record<string, unknown>> = [];
    const refused: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];

    const prepareEntry = new PrepareOptionEntry(database, new PostgresOptionChainRepository(database));
    const openTrade = new OpenPaperTrade(tradeRepository);
    const riskRepository = new PostgresRiskStateRepository(database);
    // Read once per run rather than per idea: within a single run nothing else opens
    // positions on this account, and the count is re-derived on the next run anyway.
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

    if (minutes < LAST_SIGNAL_MINUTES) {
      const generator = new GenerateTradeIdeas(
        new PostgresStrategyVersionRepository(database),
        new PostgresStrategyMarketContextRepository(database),
        new PostgresTradeIdeaRepository(database),
      );

      for (const symbol of SCAN_SYMBOLS) {
        const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
        if (!instrument) continue;

        for (const timeframe of SCAN_TIMEFRAMES) {
          // Freshness is checked on **the series the ideas are raised from**, before
          // generating. Checking 1m while scanning 5m is not a freshness check: 1m is
          // currently written by the live poller and 5m by the history collector, so the
          // gate would pass on a series that is up to date while the strategy reads bars
          // from the day before. Generating first would also leave a trade idea in the
          // table that reads as though it described the current market.
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
            // One bar of slack: a 5m series is expected to lag by up to its own bar length.
            maxAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES + barLengthMinutes(timeframe),
          });
          if (!freshness.fresh) {
            skipped.push({ symbol, timeframe, reason: freshness.reason, explanation: freshness.explanation });
            console.error(JSON.stringify({
              level: "error", message: "Skipped a series on stale data", symbol, timeframe,
              reason: freshness.reason, explanation: freshness.explanation,
            }));
            continue;
          }

          const results = await generator.execute({ instrumentId: instrument.id, timeframe });
          for (const result of results) {
            if (result.skippedReason) {
              // Reported rather than skipped in silence. "The strategy ran and found no
              // setup" and "the strategy never ran" produce the same empty output
              // otherwise, and only one of them is a market observation.
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
              if (openPositions >= MAX_CONCURRENT_POSITIONS) {
                refused.push({
                  tradeIdeaId, symbol, reason: "POSITION_LIMIT",
                  explanation: `Already holding ${openPositions} positions, the limit is ${MAX_CONCURRENT_POSITIONS}.`,
                });
                continue;
              }

              // The service picks the contract from the provider's calendar and
              // fills at the observed ask; everything it refuses on is reported rather than
              // counted as a pass.
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
                  tradeIdeaId,
                  symbol,
                  timeframe,
                  reason: "RISK_CONTROL_VETO",
                  explanation: `Risk engine refused the entry: ${riskDecision.reasonCodes.join(", ")}.`,
                });
                continue;
              }
              // The bot deliberately starts at one lot. The portfolio engine may reduce
              // that allowance, but it cannot silently size an unattended strategy up.
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
                  explanation: `A position in ${key} is already open; a persisting signal must not `
                    + "become a new position on every scan.",
                });
                continue;
              }

              const riskNote = ` Risk checks: ${riskDecision.reasonCodes.join(", ")}.`;

              const trade = await openTrade.execute({
                accountId: account.id,
                tradeIdeaId,
                fillPrice: entry.fillPrice,
                quantity: approvedQuantity,
                openedAt: now,
                entryFees: entry.entryFees,
                entrySlippage: 0,
                notes: `Opened by ${BOT_ACCOUNT_NAME} from a ${timeframe} ${symbol} signal.${riskNote}`,
                orderType: "MARKET",
                stopLossOverride: entry.stopLossOverride,
                targetPriceOverride: entry.targetPriceOverride,
                sideOverride: entry.side,
                feeBreakdown: entry.feeBreakdown,
                applyBrokerageFees: false,
                optionContract: entry.optionContract,
              });

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
                barAgeMinutes: Math.round(freshness.ageMinutes),
                // Reported on every position, not only when empty: a trade that passed a
                // partially-evaluated gate should say so on its own record.
                unchecked: entry.unchecked,
              });
            }
          }
        }
      }
    }

    // Existing positions still need their stops enforced. Fees are the brokerage model's,
    // not zero: a close priced without them reports a profit the account never had.
    const evaluation = await new EvaluateOpenPaperTrades(
      tradeRepository,
      new PostgresCandleRepository(database),
      new PostgresIndiaVixImpliedVolatilitySource(database),
    ).execute({ accountId: account.id, asOf: now });

    console.info(JSON.stringify({
      level: "info",
      message: "Paper trading bot run complete",
      mode: "OPTION_BUYER",
      positionsOpened: opened.length,
      signalsRefused: refused.length,
      openPositionsAfterRun: openPositions,
      positionLimit: MAX_CONCURRENT_POSITIONS,
      skippedSymbols: skipped.length,
      strategiesRun: strategyOutcomes.filter((outcome) => outcome.skippedReason === null).length,
      tradesEvaluated: evaluation.openTradesRead + evaluation.pendingTradesRead,
      tradesClosed: evaluation.tradesClosed,
      evaluationFailures: evaluation.evaluationFailures,
      opened,
      strategyOutcomes,
      // Refusals are output, not noise. A run that opens nothing has to be distinguishable
      // from a run that found nothing.
      refused,
      skipped,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Paper trading bot failed:", error);
  process.exitCode = 1;
});
