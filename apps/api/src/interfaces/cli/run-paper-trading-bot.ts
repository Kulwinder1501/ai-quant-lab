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
import { PostgresRiskStateRepository } from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { defaultRiskPolicy, evaluateRisk } from "../../modules/risk-management/domain/risk.js";

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

export interface BotSandboxSpec {
  name: string;
  allowedStrategies: readonly string[];
  initialBalance: number;
}

/**
 * Two scalping sandboxes whose only intended difference is candlestick and price-action patterns.
 *
 * Sniper deliberately carries Classic's `momentum-scalp-index` as well as the pattern strategies,
 * because the question being asked is "do patterns add anything to the strategy already running",
 * and that is only answerable if both bots see the same base signal. It listed the pattern
 * strategy alone until 2026-08-17, which made the two arms disjoint rather than nested: Sniper
 * took no trade at all that day while Classic took eleven, so the comparison had one arm with a
 * sample of zero.
 *
 * Overlapping strategies are safe and are the point. `trade_idea_id` on `paper_trades` carries no
 * uniqueness constraint and `prepare-option-entry` has no consumed-guard, so one idea legitimately
 * becomes one position per account -- both bots acting on the same signal, which is the
 * comparison. Every per-bot limit is already scoped to its account: `heldContracts`,
 * `MAX_CONCURRENT_POSITIONS`, and the risk state lookup.
 *
 * The arms are now exactly nested: Classic is the base strategy, Sniper is the base strategy plus
 * patterns. Nothing else differs, so a difference in their results is attributable to patterns
 * and to nothing else. `trend-breakout` was removed from Classic on 2026-08-17 to get there -- it
 * is a 15m-and-slower trend strategy rather than a scalp, so it was both an asymmetry between the
 * arms and outside the band these bots own.
 *
 * That leaves `trend-breakout` traded by no bot. It is still registered, so idea generation still
 * runs it and its ideas remain available to research and backtesting; the autonomous agent does
 * not read this registry and is unaffected. `momentum-scalp` is unowned for the same reason.
 * Neither is a bug, but an unowned strategy produces ideas nothing will act on, which is worth
 * knowing before reading an idea count as intent to trade.
 */
export const DUAL_BOT_SANDBOX: readonly BotSandboxSpec[] = [
  {
    name: "AutoBot-Classic",
    allowedStrategies: ["momentum-scalp-index"],
    initialBalance: 1_000_000,
  },
  {
    name: "AutoBot-Sniper",
    allowedStrategies: [
      "momentum-scalp-index",
      "momentum-scalp-pattern",
      "momentum-scalp-pattern-v2",
    ],
    initialBalance: 1_000_000,
  },
];

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
          generatedBySeries.push({ symbol, timeframe, results });
        }
      }
    }

    const botReports: Array<Record<string, unknown>> = [];

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

      for (const { symbol, timeframe, results } of generatedBySeries) {
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

            const trade = await openTrade.execute({
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
              unchecked: entry.unchecked,
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

      botReports.push({
        botName: botSpec.name,
        accountId: account.id,
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
      bots: botReports,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Paper trading bot failed:", error);
  process.exitCode = 1;
});
