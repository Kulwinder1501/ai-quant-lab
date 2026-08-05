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
];
