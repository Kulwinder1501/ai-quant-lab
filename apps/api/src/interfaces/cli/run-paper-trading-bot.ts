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
import { assessDataFreshness } from "../../modules/paper-trading/domain/bot-data-freshness.js";
import { calculateEntryFees, calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";
import { lotsToQuantity } from "../../modules/paper-trading/domain/lot-size-validator.js";

/**
 * Generates and prices trade signals. **It does not open positions.**
 *
 * It used to. What it opened was a position in NIFTY50 or BANKNIFTY at the index close,
 * which is not a purchasable instrument -- the same error as the phantom BANKNIFTY weekly
 * two paper trades were once booked against. It also sized at `quantity: 1` against lots of
 * 75 and 15, and passed `entryFees: 0` / `exitFees: 0` while this project's own measurement
 * puts fees at 3.3x the bid-ask spread. Every P&L it produced was wrong in three independent
 * ways, and none of them would have shown up as an error.
 *
 * Signal-only until it goes through the validated options path, which already carries the
 * expiry calendar, the entry gate and chain-mid marking. Each signal is reported with the
 * lot-correct quantity and a real round-trip fee estimate, so those numbers are visible now
 * rather than discovered once something depends on them.
 *
 * Open positions are still evaluated: a stop that stops firing is worse than a bot that does
 * not trade. Fees there now come from the brokerage model instead of being zeroed.
 */

const BOT_ACCOUNT_NAME = "AutoBot";
const SCAN_SYMBOLS = ["NIFTY50", "BANKNIFTY"] as const;
const SCAN_TIMEFRAMES = ["5m"] as const;
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

    const signals: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];

    if (minutes < LAST_SIGNAL_MINUTES) {
      const generator = new GenerateTradeIdeas(
        new PostgresStrategyVersionRepository(database),
        new PostgresStrategyMarketContextRepository(database),
        new PostgresTradeIdeaRepository(database),
      );

      for (const symbol of SCAN_SYMBOLS) {
        const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
        if (!instrument) continue;

        // Freshness is checked *before* generating. A signal derived from a stale series is
        // not worth recording, and generating first would leave a trade idea in the table
        // that reads as though it described the current market.
        const latest = await database.query<{ close_time: Date; close: string }>(
          `SELECT close_time, close FROM candles
           WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
           ORDER BY close_time DESC LIMIT 1`,
          [instrument.id],
        );
        const freshness = assessDataFreshness({
          symbol,
          latestBarCloseTime: latest.rows[0]?.close_time ?? null,
          now,
        });
        if (!freshness.fresh) {
          skipped.push({ symbol, reason: freshness.reason, explanation: freshness.explanation });
          console.error(JSON.stringify({
            level: "error", message: "Skipped a symbol on stale data", symbol,
            reason: freshness.reason, explanation: freshness.explanation,
          }));
          continue;
        }

        const referencePrice = Number(latest.rows[0]!.close);
        const lotSize = Number((instrument as { lotSize?: number }).lotSize ?? 0);

        for (const timeframe of SCAN_TIMEFRAMES) {
          const results = await generator.execute({ instrumentId: instrument.id, timeframe });
          for (const result of results) {
            if (result.skippedReason) continue;
            for (const tradeIdeaId of result.tradeIdeaIds) {
              // Sized and costed as it would actually trade, so the figures are visible
              // before anything depends on them. `quantity: 1` against a lot of 75 was not
              // a small position, it was an impossible one.
              const quantity = lotSize > 0 ? lotsToQuantity(1, lotSize) : null;
              const fees = quantity === null ? null : {
                entry: calculateEntryFees(referencePrice, quantity).total,
                exit: calculateExitFees(referencePrice, quantity).total,
              };
              signals.push({
                tradeIdeaId,
                symbol,
                timeframe,
                referencePrice,
                barAgeMinutes: Math.round(freshness.ageMinutes),
                lotSize: lotSize > 0 ? lotSize : null,
                quantityForOneLot: quantity,
                estimatedRoundTripFees: fees === null ? null : Number((fees.entry + fees.exit).toFixed(2)),
                wouldOpen: false,
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
      message: "Paper trading bot run complete (signal-only; no positions opened)",
      mode: "SIGNAL_ONLY",
      signals: signals.length,
      skippedSymbols: skipped.length,
      tradesEvaluated: evaluation.openTradesRead + evaluation.pendingTradesRead,
      tradesClosed: evaluation.tradesClosed,
      evaluationFailures: evaluation.evaluationFailures,
      details: signals,
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
