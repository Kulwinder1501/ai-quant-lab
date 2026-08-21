import { initialSchemaMigration } from "./001-initial-schema.js";
import { tradeIdeaProposalIdentityMigration } from "./002-trade-idea-proposal-identity.js";
import { modelPredictionIdentityMigration } from "./003-model-prediction-identity.js";
import { marketNewsSchemaMigration } from "./004-market-news-schema.js";
import { aiMemoryAndRagMigration } from "./005-ai-memory-and-rag.js";
import { addRegimeEvidenceMigration } from "./006-add-regime-evidence.js";
import { institutionalFlowsAndOffshoreMigration } from "./007-institutional-flows-and-offshore.js";
import { addNewsProvidersMigration } from "./008-add-news-providers.js";
import { pendingPaperTradesMigration } from "./009-pending-paper-trades.js";
import { institutionalFlowAsOfMigration } from "./010-institutional-flow-as-of.js";
import { auxiliaryModelPredictionsMigration } from "./011-auxiliary-model-predictions.js";
import { removePseudoEmbeddingsMigration } from "./012-remove-pseudo-embeddings.js";
import { purgeFabricatedRsiMigration } from "./013-purge-fabricated-rsi.js";
import { correctSeedCandleProvenanceMigration } from "./014-correct-seed-candle-provenance.js";
import { tradeReviewsMigration } from "./015-trade-reviews.js";
import { scheduledJobRunsMigration } from "./016-scheduled-job-runs.js";
import { purgeSeededTradeIdeasMigration } from "./017-purge-seeded-trade-ideas.js";
import { reopenUnsettledCandlesMigration } from "./018-reopen-unsettled-candles.js";
import { fnoInstrumentsAndFeesMigration } from "./019-fno-instruments-and-fees.js";
import { correctFnoContractSpecsMigration } from "./020-correct-fno-contract-specs.js";
import { weeklyExpiryWeekdayMigration } from "./021-weekly-expiry-weekday.js";
import { paperTradeOptionContractMigration } from "./022-paper-trade-option-contract.js";
import { optionContractRequiresLongMigration } from "./023-option-contract-requires-long.js";
import { weeklyExpiryProvenanceMigration } from "./024-weekly-expiry-provenance.js";
import { modelCompetitionMigration } from "./025-model-competition.js";
import { purgeFabricatedPredictionsMigration } from "./026-purge-fabricated-predictions.js";
import { equityTrainingUniverseMigration } from "./027-equity-training-universe.js";
import { marketContextIntegrityMigration } from "./028-market-context-integrity.js";
import { providerCredentialsMigration } from "./029-provider-credentials.js";
import { etfIndexProxiesMigration } from "./030-etf-index-proxies.js";
import { auxiliaryPredictionSettlementMigration } from "./031-auxiliary-prediction-settlement.js";
import { volatilityCompetitionMigration } from "./032-volatility-competition.js";
import { purgeSeeded1hCandlesMigration } from "./033-purge-seeded-1h-candles.js";
import { dataReadinessReportsMigration } from "./034-data-readiness-reports.js";
import { purgeExpiredProvisionalCandlesMigration } from "./035-purge-expired-provisional-candles.js";
import { sequenceReadinessReportsMigration } from "./036-sequence-readiness-reports.js";
import { optionChainSnapshotsMigration } from "./037-option-chain-snapshots.js";
import { confirmedExpiryCalendarMigration } from "./038-confirmed-expiry-calendar.js";
import { optionExpiryCalendarMigration } from "./039-option-expiry-calendar.js";
import { addExcludedFromEvidenceMigration } from "./040-add-excluded-from-evidence.js";
import { volatilityShadowEnrollmentsMigration } from "./041-volatility-shadow-enrollments.js";
import { purgeSyntheticVerificationRowsMigration } from "./042-purge-synthetic-verification-rows.js";
import { candleSeriesProvenanceMigration } from "./043-candle-series-provenance.js";
import { paperTradeUnderlyingEntryMigration } from "./044-paper-trade-underlying-entry.js";
import { addSmcIndicatorsMigration } from "./045-add-smc-indicators.js";
import { addRemainingSmcMigration } from "./046-add-remaining-smc.js";
import { purgeInProgressSeedBarsMigration } from "./047-purge-in-progress-seed-bars.js";
import { purgeLookAheadSmcSnapshotsMigration } from "./048-purge-look-ahead-smc-snapshots.js";
import { reconcileAbandonedJobRunsMigration } from "./049-reconcile-abandoned-job-runs.js";
import { addBaselineAccuracyMigration } from "./050-add-baseline-accuracy.js";
import { addVolatilityIndicesMigration } from "./051-add-volatility-indices.js";
import { aiBrainThoughtsMigration } from "./052-ai-brain-thoughts.js";
import { reapplyBankniftyLotSizeMigration } from "./053-reapply-banknifty-lot-size.js";
import { optionPremiumTicksMigration } from "./054-option-premium-ticks.js";
import { driverTapeAdjustmentsMigration } from "./055-driver-tape-adjustments.js";
import { scheduledEventsAndHolidaysMigration } from "./056-scheduled-events-and-holidays.js";
import { calendarVerificationMigration } from "./057-calendar-verification.js";
import { driverTapeOutcomeLinksMigration } from "./058-driver-tape-outcome-links.js";
import { volatilityStraddleRunsMigration } from "./059-volatility-straddle-runs.js";
import { paperTradeNotificationStreamMigration } from "./060-paper-trade-notification-stream.js";
import { paperTradeStopEffectiveAtMigration } from "./061-paper-trade-stop-effective-at.js";
import { expandPatternCodesMigration } from "./062-expand-pattern-codes.js";
import { expandPriceActionEventsMigration } from "./063-expand-price-action-events.js";
import { paperTradePartialExitsMigration } from "./064-paper-trade-partial-exits.js";
import { expandAdditionalPatternsMigration } from "./065-expand-additional-patterns.js";
import { paperAccountDailyTradeCapMigration } from "./066-paper-account-daily-trade-cap.js";
import { regimeObservationsMigration } from "./067-regime-observations.js";
import { candidateLedgerMigration } from "./068-candidate-ledger.js";
import { optionTickRejectedVolumeMigration } from "./069-option-tick-rejected-volume.js";
import { depthFramesMigration } from "./070-depth-frames.js";
import { depthFrameCaptureSessionMigration } from "./071-depth-frame-capture-session.js";

export const migrations = [
  initialSchemaMigration,
  tradeIdeaProposalIdentityMigration,
  modelPredictionIdentityMigration,
  marketNewsSchemaMigration,
  aiMemoryAndRagMigration,
  addRegimeEvidenceMigration,
  institutionalFlowsAndOffshoreMigration,
  addNewsProvidersMigration,
  pendingPaperTradesMigration,
  institutionalFlowAsOfMigration,
  auxiliaryModelPredictionsMigration,
  removePseudoEmbeddingsMigration,
  purgeFabricatedRsiMigration,
  correctSeedCandleProvenanceMigration,
  tradeReviewsMigration,
  scheduledJobRunsMigration,
  purgeSeededTradeIdeasMigration,
  reopenUnsettledCandlesMigration,
  fnoInstrumentsAndFeesMigration,
  correctFnoContractSpecsMigration,
  weeklyExpiryWeekdayMigration,
  paperTradeOptionContractMigration,
  optionContractRequiresLongMigration,
  weeklyExpiryProvenanceMigration,
  modelCompetitionMigration,
  purgeFabricatedPredictionsMigration,
  equityTrainingUniverseMigration,
  marketContextIntegrityMigration,
  providerCredentialsMigration,
  etfIndexProxiesMigration,
  auxiliaryPredictionSettlementMigration,
  volatilityCompetitionMigration,
  purgeSeeded1hCandlesMigration,
  dataReadinessReportsMigration,
  purgeExpiredProvisionalCandlesMigration,
  sequenceReadinessReportsMigration,
  optionChainSnapshotsMigration,
  confirmedExpiryCalendarMigration,
  optionExpiryCalendarMigration,
  addExcludedFromEvidenceMigration,
  volatilityShadowEnrollmentsMigration,
  purgeSyntheticVerificationRowsMigration,
  candleSeriesProvenanceMigration,
  paperTradeUnderlyingEntryMigration,
  addSmcIndicatorsMigration,
  addRemainingSmcMigration,
  purgeInProgressSeedBarsMigration,
  purgeLookAheadSmcSnapshotsMigration,
  reconcileAbandonedJobRunsMigration,
  addBaselineAccuracyMigration,
  addVolatilityIndicesMigration,
  aiBrainThoughtsMigration,
  reapplyBankniftyLotSizeMigration,
  optionPremiumTicksMigration,
  driverTapeAdjustmentsMigration,
  scheduledEventsAndHolidaysMigration,
  calendarVerificationMigration,
  driverTapeOutcomeLinksMigration,
  volatilityStraddleRunsMigration,
  paperTradeNotificationStreamMigration,
  paperTradeStopEffectiveAtMigration,
  expandPatternCodesMigration,
  expandPriceActionEventsMigration,
  paperTradePartialExitsMigration,
  expandAdditionalPatternsMigration,
  paperAccountDailyTradeCapMigration,
  regimeObservationsMigration,
  candidateLedgerMigration,
  optionTickRejectedVolumeMigration,
  depthFramesMigration,
  depthFrameCaptureSessionMigration,
];
