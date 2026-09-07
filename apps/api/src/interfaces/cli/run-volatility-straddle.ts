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
  source_timeframe: string;
}

/** Bar length in minutes, for the timeframes any volatility model is fitted on. */
const TIMEFRAME_MINUTES: Readonly<Record<string, number>> = {
  "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60,
  // A daily bar is one trading session, not 24 hours. Using 1,440 would inflate the horizon by
  // almost four times and let a 1d signal clear a gate it had not earned.
  "1d": 375,
};

/**
 * How far ahead a prediction reaches, in years, from its bar length and horizon.
 *
 * Calendar years, matching `yearsToExpiry` and the annualisation convention of the implied
 * volatility it will be multiplied against. Returns null for a timeframe this does not know
 * rather than guessing: the straddle gate depends on this number, and a wrong horizon silently
 * moves the threshold it enforces.
 */
function predictionHorizonYears(timeframe: string, horizonBars: number): number | null {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (minutes === undefined || !Number.isFinite(horizonBars) || horizonBars < 1) return null;
  return (minutes * horizonBars) / (365 * 24 * 60);
}

/**
 * Calendar minutes one bar spans, which is a different clock from `TIMEFRAME_MINUTES`.
 *
 * Volatility accumulates in market time -- that is why a daily bar counts as 375 minutes above --
 * but theta runs on the calendar, and an option does not stop decaying overnight. Five daily bars
 * hold 1,875 trading minutes and consume about seven calendar days of a contract's life. The two
 * numbers answer different questions and neither substitutes for the other: the first scales the
 * implied move the signal is compared against, the second measures how much of the contract's
 * remaining life the signal's span covers.
 *
 * Intraday entries are exact only while the horizon stays inside one session. A 15m/h5 signal at
 * 15:15 IST reaches into tomorrow, spanning 75 trading minutes but eighteen calendar hours; the
 * ratio below understates the mismatch in that window rather than overstating it.
 */
const TIMEFRAME_CALENDAR_MINUTES: Readonly<Record<string, number>> = {
  "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60,
  "1d": 1440,
};

function horizonCalendarYears(timeframe: string, horizonBars: number): number | null {
  const minutes = TIMEFRAME_CALENDAR_MINUTES[timeframe];
  if (minutes === undefined || !Number.isFinite(horizonBars) || horizonBars < 1) return null;
  return (minutes * horizonBars) / (365 * 24 * 60);
}

/**
 * The most remaining contract life, per unit of prediction horizon, that this path will finance.
 *
 * Derived rather than chosen. The position is closed on premium barriers with no time stop, so the
 * binding constraint is the hold-to-expiry one: the underlying has to travel the whole premium,
 * and an at-the-money premium scales with the square root of remaining life. A tenor of `n` times
 * the horizon therefore costs `sqrt(n)` times the move the signal predicts. At 4 that is a 2x
 * penalty -- already severe, and the point past which the mismatch dominates every other term.
 *
 * Measured 2026-08-17: a 15m/h5 prediction spans 75 minutes against the 8-day contract the
 * calendar offered, a ratio of 154 and a 12x penalty. No listed expiry is short enough to fix
 * that, because the signal is the wrong length, not the contract. So the selection changed
 * direction: instead of taking the freshest prediction and buying whatever tenor exists, take the
 * freshest prediction whose horizon the tenor can actually express, and refuse when none can.
 * A daily-bar model reaches a weekly expiry; a 15-minute one never will.
 */
const MAXIMUM_TENOR_HORIZON_RATIO = 4;

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

    /*
     * The tenor is settled before the prediction is chosen, because it is the fixed side. The
     * listed calendar decides what remaining life is buyable; the only free choice is which
     * signal's horizon that life can express. Selecting the prediction first and taking whatever
     * expiry existed is what produced a 75-minute view carried on an 8-day contract.
     */
    const optionChainRepository = new PostgresOptionChainRepository(database);
    const calendar = await optionChainRepository.latestExpiryCalendar(UNDERLYING);
    const expirySelection = selectNearestListedExpiry(calendar, now, MINIMUM_DAYS_TO_EXPIRY);
    const tenorYears = expirySelection.usable
      ? (expirySelection.expiryDate.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000)
      : null;

    const predictionResult = await database.query<ExpansionRow>(`
      SELECT p.id, p.prediction, p.confidence, p.realized_trailing_range, p.source_candle_id,
             p.instrument_id, p.evidence_cutoff_at,
             (mv.validation_metrics -> 'validationProtocol' ->> 'expansionBand') AS expansion_band,
             (mv.validation_metrics -> 'validationProtocol' ->> 'horizonBars') AS horizon_bars,
             -- The bar length this prediction was made on. With horizonBars it gives the span the
             -- predicted range covers, which is what the implied move has to be scaled to.
             source_candle.timeframe AS source_timeframe
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
      -- Candidates, not one row: several volatility models can be enrolled on different
      -- timeframes at once, and the horizon that matches the buyable tenor is not always the
      -- freshest prediction. Freshness still orders them, so the match is the freshest usable one.
      LIMIT 25
    `, [
      instrument.id,
      VOLATILITY_LABEL_SCHEME,
      now,
      MINIMUM_EXPANSION_CONFIDENCE,
      MAXIMUM_PREDICTION_AGE_MINUTES,
    ]);

    // flatMap rather than filter so the label narrows: the domain input takes a VolatilityLabel,
    // and a boolean predicate would leave it a bare string.
    const candidates = predictionResult.rows.flatMap((candidate) => isVolatilityLabel(candidate.prediction)
      ? [{ ...candidate, prediction: candidate.prediction }]
      : []);
    if (candidates.length === 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "NO_EXPANSION_PREDICTION",
        explanation: `No fresh, unsettled, enrolled EXPANSION prediction at or above ${MINIMUM_EXPANSION_CONFIDENCE} for ${UNDERLYING}.`,
      }));
      return;
    }

    /*
     * Pick the freshest candidate whose horizon the buyable tenor can express. `horizonBars`
     * defaults to 5 only when the model version recorded none, which is how it has always
     * behaved; the bar length is never defaulted, because it sets the threshold the signal must
     * clear and an assumed one moves that threshold silently.
     */
    const assessed = candidates.map((candidate) => {
      const bars = candidate.horizon_bars === null ? 5 : Number(candidate.horizon_bars);
      const horizonBars = Number.isInteger(bars) ? bars : 5;
      const calendarYears = horizonCalendarYears(candidate.source_timeframe, horizonBars);
      return {
        candidate,
        horizonBars,
        horizonYears: predictionHorizonYears(candidate.source_timeframe, horizonBars),
        // Null tenor means no listed expiry was usable. The ratio is then unknown rather than
        // infinite, and the domain refuses EXPIRY_UNLISTED a few lines below on the same facts.
        tenorRatio: tenorYears === null || calendarYears === null ? null : tenorYears / calendarYears,
      };
    });
    const unknownHorizon = assessed.filter((entry) => entry.horizonYears === null);
    const matched = assessed.find((entry) => entry.horizonYears !== null
      && (entry.tenorRatio === null || entry.tenorRatio <= MAXIMUM_TENOR_HORIZON_RATIO));

    if (!matched) {
      if (unknownHorizon.length === assessed.length) {
        console.info(JSON.stringify({
          level: "warn",
          message: "Volatility straddle refused",
          actionable: false,
          reason: "PREDICTION_HORIZON_UNKNOWN",
          explanation: `Timeframe "${unknownHorizon[0]!.candidate.source_timeframe}" has no known bar `
            + "length, so the horizon the predicted range spans cannot be computed and the implied "
            + "move cannot be scaled to it.",
          sourceTimeframe: unknownHorizon[0]!.candidate.source_timeframe,
          horizonBars: unknownHorizon[0]!.horizonBars,
        }));
        return;
      }
      const ratios = assessed
        .map((entry) => entry.tenorRatio)
        .filter((ratio): ratio is number => ratio !== null)
        .sort((left, right) => left - right);
      const closestRatio = ratios[0];
      const tenorDays = tenorYears === null ? null : tenorYears * 365;
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: "NO_HORIZON_MATCHED_TENOR",
        explanation: `The nearest listed expiry at least ${MINIMUM_DAYS_TO_EXPIRY} days out leaves `
          + `${tenorDays === null ? "an unknown number of" : tenorDays.toFixed(1)} days of contract life. The `
          + `closest prediction horizon covers 1/${closestRatio === undefined ? "?" : closestRatio.toFixed(1)} of `
          + `it, past the ${MAXIMUM_TENOR_HORIZON_RATIO} limit, which is a `
          + `${closestRatio === undefined ? "n unmeasured" : `${Math.sqrt(closestRatio).toFixed(1)}x`} penalty on the `
          + "move the signal has to produce. Buying this tenor finances time the signal says nothing about, and "
          + "it is why the premium gate refused every live evaluation. Closing it needs a longer-horizon "
          + "volatility model, not a different strike or a nearer expiry.",
        tenorDays: tenorDays === null ? null : Number(tenorDays.toFixed(2)),
        candidates: assessed.map((entry) => ({
          predictionId: entry.candidate.id,
          timeframe: entry.candidate.source_timeframe,
          horizonBars: entry.horizonBars,
          tenorRatio: entry.tenorRatio === null ? null : Number(entry.tenorRatio.toFixed(2)),
        })),
      }));
      return;
    }

    const row = matched.candidate;
    const horizonBars = matched.horizonBars;
    const horizonYears = matched.horizonYears as number;
    const expansionBand = row.expansion_band === null ? null : Number(row.expansion_band);
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
      predictionHorizonYears: horizonYears,
      now,
    });

    if (!proposal.actionable) {
      console.info(JSON.stringify({
        level: "info",
        message: "Volatility straddle refused",
        actionable: false,
        reason: proposal.reason,
        explanation: proposal.explanation,
        // Present only for the economics gates, and the reason the refusal is auditable: the
        // horizon terms say what the same signal would have been worth on a matched tenor.
        economics: proposal.economics ?? null,
        sourceTimeframe: row.source_timeframe,
        horizonBars,
        tenorRatio: matched.tenorRatio === null ? null : Number(matched.tenorRatio.toFixed(2)),
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

    const prepareEntry = new PrepareOptionEntry(
      database,
      optionChainRepository,
      new PostgresOptionPremiumTickRepository(database),
    );
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
