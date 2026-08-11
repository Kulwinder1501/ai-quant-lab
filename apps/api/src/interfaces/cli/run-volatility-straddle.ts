import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { PostgresRiskStateRepository } from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { selectNearestListedExpiry } from "../../modules/market-data/domain/option-expiry-calendar.js";
import { isVolatilityLabel } from "../../modules/model-predictions/domain/volatility-expansion-label.js";
import { MINIMUM_DAYS_TO_EXPIRY, PrepareOptionEntry } from "../../modules/paper-trading/application/prepare-option-entry.js";
import { proposeVolatilityStraddle } from "../../modules/paper-trading/domain/volatility-straddle.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { VOLATILITY_LABEL_SCHEME } from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import type { TradeSide } from "../../modules/strategy-engine/domain/strategy.js";
import { evaluateRisk } from "../../modules/risk-management/domain/risk.js";
import type { OpenPaperTradeInput } from "../../modules/paper-trading/domain/paper-trading.js";
import { isNseHoliday } from "../../modules/market-data/domain/nse-session-calendar.js";

/**
 * Vol-expansion paper path: propose a long straddle, persist CE+PE trade ideas,
 * and attempt the gated open path. Refusals exit 0 — they dominate in practice.
 */

const ACCOUNT_NAME = "VolatilityStraddle";
const UNDERLYING = "NIFTY50";
const SOURCE = "volatility-straddle";
const MINIMUM_EXPANSION_CONFIDENCE = 0.44;
const MAXIMUM_PREDICTION_AGE_MINUTES = 20;

interface ExpansionRow {
  id: string;
  prediction: string;
  confidence: string;
  realized_trailing_range: string | null;
  expansion_band: string | null;
  horizon_bars: string | null;
  source_candle_id: string | null;
  instrument_id: string;
  evidence_cutoff_at: Date;
}

/**
 * Trailing high-low envelope at the signal bar — usable before settlement.
 * `realized_trailing_range` is only filled when the auxiliary prediction settles.
 */
async function trailingRangeAtSourceCandle(
  database: ReturnType<typeof createDatabasePool>,
  sourceCandleId: string,
  horizonBars: number,
): Promise<number | null> {
  if (!Number.isInteger(horizonBars) || horizonBars < 1) return null;
  const source = await database.query<{
    instrument_id: string;
    timeframe: string;
    close_time: Date;
  }>(`
    SELECT instrument_id, timeframe, close_time
    FROM candles
    WHERE id = $1
  `, [sourceCandleId]);
  const candle = source.rows[0];
  if (!candle) return null;

  const window = await database.query<{ high: string; low: string }>(`
    SELECT high, low
    FROM candles
    WHERE instrument_id = $1
      AND timeframe = $2
      AND close_time <= $3
      AND is_complete = TRUE
    ORDER BY close_time DESC, open_time DESC, id DESC
    LIMIT $4
  `, [candle.instrument_id, candle.timeframe, candle.close_time, horizonBars]);

  if (window.rows.length < horizonBars) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const row of window.rows) {
    const h = Number(row.high);
    const l = Number(row.low);
    if (!Number.isFinite(h) || !Number.isFinite(l) || h < l) return null;
    high = Math.max(high, h);
    low = Math.min(low, l);
  }
  const range = high - low;
  return range > 0 ? range : null;
}

async function insertIdea(input: {
  database: ReturnType<typeof createDatabasePool>;
  instrumentId: string;
  sourceCandleId: string | null;
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning: string[];
  evidence: Record<string, unknown>;
}): Promise<string> {
  const result = await input.database.query<{ id: string }>(`
    INSERT INTO trade_ideas (
      instrument_id, strategy_version_id, source_candle_id, side, status,
      entry_price, stop_loss, target_price, risk_reward, confidence,
      reasoning, evidence, expires_at
    ) VALUES (
      $1, NULL, $2, $3, 'PROPOSED',
      $4, $5, $6, $7, $8,
      $9::jsonb, $10::jsonb, NOW() + INTERVAL '4 hours'
    )
    RETURNING id
  `, [
    input.instrumentId,
    input.sourceCandleId,
    input.side,
    input.entryPrice,
    input.stopLoss,
    input.targetPrice,
    input.riskReward,
    input.confidence,
    JSON.stringify(input.reasoning),
    JSON.stringify(input.evidence),
  ]);
  return result.rows[0]!.id;
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const now = new Date();

  let claimedRunId: string | null = null;
  try {
    const holiday = await isNseHoliday(database, now);
    if (holiday.holiday) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        reason: "NSE_HOLIDAY",
        explanation: holiday.name,
      }));
      return;
    }

    const instrumentRepository = new PostgresInstrumentRepository(database);
    const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", UNDERLYING);
    if (!instrument) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "INSTRUMENT_MISSING",
        explanation: `${UNDERLYING} is not registered.`,
      }));
      return;
    }

    const predictionResult = await database.query<ExpansionRow>(`
      SELECT p.id, p.prediction, p.confidence, p.realized_trailing_range, p.source_candle_id,
             p.instrument_id, p.evidence_cutoff_at,
             (mv.validation_metrics -> 'validationProtocol' ->> 'expansionBand') AS expansion_band,
             (mv.validation_metrics -> 'validationProtocol' ->> 'horizonBars') AS horizon_bars
      FROM auxiliary_model_predictions p
      INNER JOIN model_versions mv ON mv.id = p.model_version_id
      INNER JOIN volatility_shadow_enrollments vse
        ON vse.model_version_id = p.model_version_id AND vse.label_scheme = p.label_scheme
      INNER JOIN candles source_candle ON source_candle.id = p.source_candle_id
      WHERE p.instrument_id = $1
        AND p.label_scheme = $2
        AND p.prediction = 'EXPANSION'
        AND p.settled_at IS NULL
        AND p.confidence >= $4
        AND p.evidence_cutoff_at <= $3
        AND p.evidence_cutoff_at >= $3 - ($5 * INTERVAL '1 minute')
        AND source_candle.is_complete = TRUE
      ORDER BY
        p.evidence_cutoff_at DESC,
        p.created_at DESC
      LIMIT 1
    `, [
      instrument.id,
      VOLATILITY_LABEL_SCHEME,
      now,
      MINIMUM_EXPANSION_CONFIDENCE,
      MAXIMUM_PREDICTION_AGE_MINUTES,
    ]);

    const row = predictionResult.rows[0];
    if (!row || !isVolatilityLabel(row.prediction)) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "NO_EXPANSION_PREDICTION",
        explanation: `No fresh, unsettled, enrolled EXPANSION prediction at or above ${MINIMUM_EXPANSION_CONFIDENCE} for ${UNDERLYING}.`,
      }));
      return;
    }

    const expansionBand = row.expansion_band === null ? null : Number(row.expansion_band);
    const horizonBars = row.horizon_bars === null ? 5 : Number(row.horizon_bars);
    let trailingRange = row.realized_trailing_range === null
      ? null
      : Number(row.realized_trailing_range);
    if ((trailingRange === null || !Number.isFinite(trailingRange)) && row.source_candle_id) {
      trailingRange = await trailingRangeAtSourceCandle(
        database,
        row.source_candle_id,
        Number.isInteger(horizonBars) ? horizonBars : 5,
      );
    }

    const denseUnderlying = await new PostgresOptionPremiumTickRepository(database)
      .latestUnderlyingValue(UNDERLYING, 2 * 60_000, now);
    const spot = denseUnderlying?.value ?? null;
    if (spot === null || !Number.isFinite(spot) || spot <= 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "NO_SPOT",
        explanation: `No Fyers underlying print newer than two minutes for ${UNDERLYING}.`,
      }));
      return;
    }

    const ivSource = new PostgresIndiaVixImpliedVolatilitySource(database);
    const impliedVolatility = await ivSource.resolveAsOf(now);

    const optionChainRepository = new PostgresOptionChainRepository(database);
    const calendar = await optionChainRepository.latestExpiryCalendar(UNDERLYING);
    const expirySelection = selectNearestListedExpiry(calendar, now, MINIMUM_DAYS_TO_EXPIRY);

    const instrumentMeta = await database.query<{ lot_size: number; strike_step: string | null }>(`
      SELECT lot_size, strike_step FROM instruments WHERE id = $1
    `, [instrument.id]);
    const meta = instrumentMeta.rows[0];
    const strikeStep = meta?.strike_step === null || meta?.strike_step === undefined
      ? null
      : Number(meta.strike_step);
    const lotSize = Number(meta?.lot_size ?? instrument.lotSize);
    if (strikeStep === null || !Number.isFinite(strikeStep) || strikeStep <= 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "NO_STRIKE_STEP",
        explanation: `${UNDERLYING} has no strike_step configured.`,
      }));
      return;
    }

    const proposal = proposeVolatilityStraddle({
      prediction: row.prediction,
      underlyingSymbol: UNDERLYING,
      underlyingSpot: spot,
      impliedVolatility,
      expiryDate: expirySelection.usable ? expirySelection.expiryDate : new Date(0),
      isListedExpiry: expirySelection.usable,
      strikeStep,
      lotSize,
      lots: 1,
      trailingRange: trailingRange !== null && Number.isFinite(trailingRange) ? trailingRange : null,
      expansionBand: expansionBand !== null && Number.isFinite(expansionBand) && expansionBand > 0
        ? expansionBand
        : 0.25,
      now,
    });

    if (!proposal.actionable) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: proposal.reason,
        explanation: proposal.explanation,
        predictionConfidence: Number(row.confidence),
        evidenceCutoffAt: row.evidence_cutoff_at,
      }));
      return;
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Volatility straddle proposed",
      actionable: true,
      rationale: proposal.rationale,
      economics: proposal.economics,
      legs: proposal.legs.map((leg) => ({
        optionType: leg.optionType,
        strike: leg.strike,
        premium: leg.premium,
      })),
      quantity: proposal.quantity,
      expiryDate: proposal.expiryDate.toISOString(),
    }));

    const requiredMove = proposal.economics.requiredMove;
    const riskReward = 2;
    const ideaConfidence = Number(row.confidence);

    const claim = await database.query<{ id: string }>(`
      INSERT INTO volatility_straddle_runs (prediction_id, status)
      VALUES ($1, 'CLAIMED')
      ON CONFLICT (prediction_id) DO NOTHING
      RETURNING id
    `, [row.id]);
    claimedRunId = claim.rows[0]?.id ?? null;
    if (claimedRunId === null) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle skipped",
        reason: "PREDICTION_ALREADY_CLAIMED",
        predictionId: row.id,
      }));
      return;
    }

    const sharedEvidence = {
      source: SOURCE,
      prediction: row.prediction,
      predictionConfidence: Number(row.confidence),
      evidenceCutoffAt: row.evidence_cutoff_at,
      economics: proposal.economics,
      rationale: proposal.rationale,
    };

    // LONG thesis → CE; SHORT thesis → PE. Both book as long option positions.
    const ceIdeaId = await insertIdea({
      database,
      instrumentId: instrument.id,
      sourceCandleId: row.source_candle_id,
      side: "LONG",
      entryPrice: spot,
      stopLoss: spot - requiredMove,
      targetPrice: spot + requiredMove * riskReward,
      riskReward,
      confidence: ideaConfidence,
      reasoning: [proposal.rationale, "volatility-straddle CE leg"],
      evidence: { ...sharedEvidence, leg: "CE" },
    });
    const peIdeaId = await insertIdea({
      database,
      instrumentId: instrument.id,
      sourceCandleId: row.source_candle_id,
      side: "SHORT",
      entryPrice: spot,
      stopLoss: spot + requiredMove,
      targetPrice: spot - requiredMove * riskReward,
      riskReward,
      confidence: ideaConfidence,
      reasoning: [proposal.rationale, "volatility-straddle PE leg"],
      evidence: { ...sharedEvidence, leg: "PE" },
    });

    let account = await new PostgresPaperAccountRepository(database).findByName(ACCOUNT_NAME);
    if (!account) {
      account = await new PostgresPaperAccountRepository(database).create({
        name: ACCOUNT_NAME,
        openingBalance: 1_000_000,
      });
    }

    await database.query(`
      UPDATE volatility_straddle_runs
      SET account_id = $2, ce_trade_idea_id = $3, pe_trade_idea_id = $4
      WHERE id = $1
    `, [claimedRunId, account.id, ceIdeaId, peIdeaId]);

    const prepareEntry = new PrepareOptionEntry(database, optionChainRepository);
    const [cePrepared, pePrepared] = await Promise.all([
      prepareEntry.execute({ tradeIdeaId: ceIdeaId, lots: 1, now }),
      prepareEntry.execute({ tradeIdeaId: peIdeaId, lots: 1, now }),
    ]);
    if (!cePrepared.approved || !pePrepared.approved) {
      const refusals = [
        ...(!cePrepared.approved ? [`CE: ${cePrepared.reason} - ${cePrepared.explanation}`] : []),
        ...(!pePrepared.approved ? [`PE: ${pePrepared.reason} - ${pePrepared.explanation}`] : []),
      ];
      await database.query(`
        UPDATE volatility_straddle_runs
        SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, refusals.join(" | ")]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", refusals }));
      return;
    }
    const unchecked = [
      ...cePrepared.entry.unchecked.map((item) => `CE: ${item}`),
      ...pePrepared.entry.unchecked.map((item) => `PE: ${item}`),
    ];
    if (unchecked.length > 0) {
      const reason = `Structure refused because mandatory checks were not measurable: ${unchecked.join(" | ")}`;
      await database.query(`
        UPDATE volatility_straddle_runs SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, reason]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", reason }));
      return;
    }

    const sameStructure = cePrepared.entry.optionContract.optionType === "CE"
      && pePrepared.entry.optionContract.optionType === "PE"
      && cePrepared.entry.optionContract.optionStrike === pePrepared.entry.optionContract.optionStrike
      && cePrepared.entry.optionContract.optionExpiry.getTime()
        === pePrepared.entry.optionContract.optionExpiry.getTime()
      && cePrepared.entry.quantity === pePrepared.entry.quantity;
    if (!sameStructure) {
      const reason = "Prepared legs do not form one equal-sized same-strike, same-expiry straddle.";
      await database.query(`
        UPDATE volatility_straddle_runs SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, reason]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", reason }));
      return;
    }

    const actualCostPerUnderlyingUnit = cePrepared.entry.fillPrice + pePrepared.entry.fillPrice
      + (cePrepared.entry.entryFees + pePrepared.entry.entryFees) / cePrepared.entry.quantity;
    if (proposal.economics.conservativeExcursion <= actualCostPerUnderlyingUnit) {
      const reason = `Actual two-leg ask-plus-fee cost ${actualCostPerUnderlyingUnit.toFixed(2)} exceeds `
        + `the conservative predicted excursion ${proposal.economics.conservativeExcursion.toFixed(2)}.`;
      await database.query(`
        UPDATE volatility_straddle_runs SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, reason]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", reason }));
      return;
    }

    const riskRepository = new PostgresRiskStateRepository(database);
    const riskState = await riskRepository.findRiskState({
      accountId: account.id,
      instrumentId: instrument.id,
      asOf: now,
      maxRegimeAgeMinutes: 60,
    });
    const riskFor = (entry: typeof cePrepared.entry, openPositionCount: number) => evaluateRisk({
      instrumentId: instrument.id,
      decisionTimestamp: now,
      side: entry.side,
      entryPrice: entry.fillPrice,
      stopLoss: entry.stopLossOverride,
      targetPrice: entry.targetPriceOverride,
      lotSize: entry.lotSize,
    }, { ...riskState, openPositionCount });
    const ceRisk = riskFor(cePrepared.entry, riskState.openPositionCount);
    const peRisk = riskFor(pePrepared.entry, riskState.openPositionCount + 1);
    if (!ceRisk.approved || !peRisk.approved) {
      const reason = `CE risk: ${ceRisk.reasonCodes.join(", ")}; PE risk: ${peRisk.reasonCodes.join(", ")}`;
      await database.query(`
        UPDATE volatility_straddle_runs SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, reason]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", reason }));
      return;
    }

    const commonQuantity = Math.min(
      cePrepared.entry.quantity,
      pePrepared.entry.quantity,
      ceRisk.approvedQuantity,
      peRisk.approvedQuantity,
    );
    if (commonQuantity < cePrepared.entry.lotSize || commonQuantity % cePrepared.entry.lotSize !== 0) {
      const reason = "Risk sizing left no equal whole-lot quantity for both straddle legs.";
      await database.query(`
        UPDATE volatility_straddle_runs SET status = 'REFUSED', reason = $2, completed_at = NOW()
        WHERE id = $1
      `, [claimedRunId, reason]);
      console.info(JSON.stringify({ level: "info", message: "Volatility straddle refused", reason }));
      return;
    }

    const toOpenInput = (
      entry: typeof cePrepared.entry,
      leg: "CE" | "PE",
    ): OpenPaperTradeInput => ({
      accountId: account.id,
      tradeIdeaId: entry.tradeIdeaId,
      fillPrice: entry.fillPrice,
      quantity: commonQuantity,
      openedAt: now,
      entryFees: entry.entryFees,
      entrySlippage: 0,
      notes: `Atomic volatility straddle ${leg} (${SOURCE}); prediction ${row.id}`,
      stopLossOverride: entry.stopLossOverride,
      targetPriceOverride: entry.targetPriceOverride,
      sideOverride: entry.side,
      feeBreakdown: entry.feeBreakdown,
      optionContract: entry.optionContract,
      optionsValidationResult: { unchecked: entry.unchecked },
    });

    const tradeRepository = new PostgresPaperTradeRepository(database);
    const [ceTrade, peTrade] = await tradeRepository.openPairFromTradeIdeas([
      toOpenInput(cePrepared.entry, "CE"),
      toOpenInput(pePrepared.entry, "PE"),
    ]);
    await database.query(`
      UPDATE volatility_straddle_runs
      SET status = 'OPENED', ce_paper_trade_id = $2, pe_paper_trade_id = $3,
          completed_at = NOW()
      WHERE id = $1
    `, [claimedRunId, ceTrade.id, peTrade.id]);

    console.info(JSON.stringify({
      level: "info",
      message: "Volatility straddle open attempts",
      account: ACCOUNT_NAME,
      ideas: { ce: ceIdeaId, pe: peIdeaId },
      predictionId: row.id,
      trades: { ce: ceTrade.id, pe: peTrade.id },
    }));
  } catch (error) {
    if (claimedRunId !== null) {
      await database.query(`
        UPDATE volatility_straddle_runs
        SET status = 'FAILED', reason = $2, completed_at = NOW()
        WHERE id = $1 AND status = 'CLAIMED'
      `, [claimedRunId, error instanceof Error ? error.message : String(error)]).catch(() => undefined);
    }
    throw error;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
