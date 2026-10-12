import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import { settleCandidate } from "../../modules/paper-trading/domain/candidate-settlement.js";
import {
  computeConfigurationHash,
  defaultMomentumScalpPatternStrategyConfiguration,
  MomentumScalpPatternStrategy,
  momentumScalpPatternStrategyVersion,
} from "../../modules/strategy-engine/domain/momentum-scalp-pattern-strategy.js";
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";
import { getOption, parseDateOption } from "./arguments.js";

/**
 * FRVP-MSP Phase 0 — export unchanged momentum-scalp-pattern candidates.
 *
 * Research-only. Does not edit the frozen strategy, does not touch production wiring.
 * Normative: docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
 *
 * Default evaluation window starts 2026-10-01 IST so the prior session (2026-09-30)
 * is OCT-only by expiry eligibility (SEP expired 2026-09-29). Earlier September dates
 * cannot prove causal OCT selection without SEP volume history.
 */

const EXPERIMENT_ID = "FRVP-MSP-P0-2026-10-12";
const STRATEGY_KEY = "momentum-scalp-pattern";
const INSTRUMENTS = ["NIFTY50", "BANKNIFTY"] as const;
const TIMEFRAMES = ["1m", "3m", "5m"] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const OUT_DIR = path.join(REPO_ROOT, "logs");
const CANDIDATES_PATH = path.join(OUT_DIR, "frvp-msp-phase0-baseline-candidates.jsonl");
const MANIFEST_PATH = path.join(OUT_DIR, "frvp-msp-phase0-baseline-manifest.json");

function istSessionDate(ts: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ts);
}

function unresolvedExitR(input: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  lastClose: number;
}): number | null {
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  if (!(risk > 0)) return null;
  const move = input.side === "LONG"
    ? input.lastClose - input.entryPrice
    : input.entryPrice - input.lastClose;
  return move / risk;
}

function atrFromContext(context: StrategyMarketContext): number | null {
  const atr = context.indicators.find(
    (row) => row.code === "ATR" && row.algorithmVersion === "ta-v1" && Number(row.parameters?.period) === 14,
  );
  const value = atr?.values && typeof atr.values === "object"
    ? Number((atr.values as Record<string, unknown>).value)
    : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Trusted causal OCT window (see file header). Override only with an explicit amendment.
  const evalFrom = parseDateOption(getOption(args, "from") ?? "2026-10-01", false);
  const evalTo = parseDateOption(getOption(args, "to") ?? "2026-10-12", true);
  const loadFrom = parseDateOption(getOption(args, "load-from") ?? "2026-09-20", false);

  const effectiveConfig = { ...defaultMomentumScalpPatternStrategyConfiguration } as Record<string, unknown>;
  const configurationHash = computeConfigurationHash(effectiveConfig);
  const strategy = new MomentumScalpPatternStrategy();

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const instruments = new PostgresInstrumentRepository(database);
  const marketData = new PostgresBacktestMarketDataRepository(database);
  const dataCutoffAt = new Date();

  const lines: string[] = [];
  const summary: Array<Record<string, unknown>> = [];

  try {
    for (const symbol of INSTRUMENTS) {
      const instrument = await instruments.findByExchangeAndSymbol("NSE", symbol);
      if (!instrument) throw new Error(`NSE instrument ${symbol} is not registered.`);

      for (const timeframe of TIMEFRAMES) {
        const contexts = await marketData.listContexts({
          instrumentId: instrument.id,
          timeframe,
          dataWindowStart: loadFrom,
          dataWindowEnd: evalTo,
          dataCutoffAt,
        });
        let generated = 0;
        let settled = 0;

        for (let i = 0; i < contexts.length; i += 1) {
          const context = contexts[i]!;
          const decisionTime = context.candle.closeTime;
          if (decisionTime < evalFrom || decisionTime > evalTo) continue;

          const proposals = strategy.evaluate(context, effectiveConfig);
          if (proposals.length === 0) continue;

          const proposal = proposals[0]!;
          if (!proposal.expiresAt) continue;

          const forward = contexts.slice(i + 1).map((ctx) => ({
            openTime: ctx.candle.openTime,
            closeTime: ctx.candle.closeTime,
            open: ctx.candle.open,
            high: ctx.candle.high,
            low: ctx.candle.low,
            close: ctx.candle.close,
            isComplete: true as const,
          }));

          const settlement = settleCandidate({
            side: proposal.side,
            entryPrice: proposal.entryPrice,
            stopLoss: proposal.stopLoss,
            targetPrice: proposal.targetPrice,
            horizonEnd: proposal.expiresAt,
            resolvedTimeframe: timeframe,
            forwardCandles: forward,
          });

          let signalR = settlement.rMultiple;
          let outcomeLabel: string = settlement.outcome;
          if (settlement.outcome === "UNRESOLVED" && forward.length > 0) {
            const within = forward.filter((bar) => bar.closeTime.getTime() <= proposal.expiresAt!.getTime());
            const last = within[within.length - 1];
            if (last) {
              signalR = unresolvedExitR({
                side: proposal.side,
                entryPrice: proposal.entryPrice,
                stopLoss: proposal.stopLoss,
                lastClose: last.close,
              });
              outcomeLabel = "EXPIRED";
            }
          }

          generated += 1;
          if (settlement.outcome !== "UNSETTLEABLE") settled += 1;

          const row = {
            experimentId: EXPERIMENT_ID,
            strategyKey: STRATEGY_KEY,
            strategyVersion: momentumScalpPatternStrategyVersion,
            configurationHash,
            effectiveConfig,
            instrumentSymbol: symbol,
            instrumentId: instrument.id,
            timeframe,
            sourceCandleId: context.candle.id,
            decisionTime: decisionTime.toISOString(),
            decisionSessionDateIst: istSessionDate(decisionTime),
            side: proposal.side,
            entryPrice: proposal.entryPrice,
            stopLoss: proposal.stopLoss,
            targetPrice: proposal.targetPrice,
            riskReward: proposal.riskReward,
            confidence: proposal.confidence,
            expiresAt: proposal.expiresAt.toISOString(),
            atr14: atrFromContext(context),
            tickSize: context.candle.tickSize,
            evidence: proposal.evidence,
            settlement: {
              outcome: outcomeLabel,
              resolverOutcome: settlement.outcome,
              signalR,
              barsToResolution: settlement.barsToResolution,
              maeR: settlement.maeR,
              mfeR: settlement.mfeR,
              barsAvailable: settlement.barsAvailable,
              resolverVersion: settlement.resolverVersion,
              frictionIndexPoints: 0,
            },
          };
          lines.push(JSON.stringify(row));
        }

        summary.push({
          symbol,
          timeframe,
          contextsLoaded: contexts.length,
          candidatesGenerated: generated,
          candidatesSettleable: settled,
        });
      }
    }
  } finally {
    await database.end();
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(CANDIDATES_PATH, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");

  const payloadHash = createHash("sha256").update(lines.join("\n")).digest("hex");
  const manifest = {
    experimentId: EXPERIMENT_ID,
    exportedAt: new Date().toISOString(),
    strategyKey: STRATEGY_KEY,
    strategyVersion: momentumScalpPatternStrategyVersion,
    configurationHash,
    effectiveConfig,
    evalFrom: evalFrom.toISOString(),
    evalTo: evalTo.toISOString(),
    loadFrom: loadFrom.toISOString(),
    instruments: [...INSTRUMENTS],
    timeframes: [...TIMEFRAMES],
    candidateCount: lines.length,
    candidatesPath: path.relative(REPO_ROOT, CANDIDATES_PATH).replace(/\\/g, "/"),
    candidatesSha256: payloadHash,
    cells: summary,
    windowRationale: (
      "Evaluation decisions from 2026-10-01 IST onward so the prior session (2026-09-30) is "
      + "OCT-only by expiry eligibility after SEP expiry 2026-09-29. AUG/SEP Fyers volume absent."
    ),
    notes: [
      "Frozen default config only; requireStrictTrendAlignment / enableSrVeto / srLookbackBars absent.",
      "Signal-only index R; friction placeholder 0; not options P&L.",
      "No production wiring; strategy source not modified.",
    ],
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ level: "info", message: "FRVP Phase 0 baseline export complete", manifest }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
